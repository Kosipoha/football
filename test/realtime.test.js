const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { test } = require('node:test');
const { io } = require('socket.io-client');

const root = path.resolve(__dirname, '..');

async function waitForServer(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error('Realtime server did not start');
}

function connectClient(url) {
  const socket = io(url, { reconnection: false, timeout: 3000 });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket connection timed out')), 4000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function waitForRoomPhase(socket, phase) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('room-state', onState);
      reject(new Error(`Did not receive room phase: ${phase}`));
    }, 5000);
    function onState(room) {
      if (room.phase !== phase) return;
      clearTimeout(timer);
      socket.off('room-state', onState);
      resolve(room);
    }
    socket.on('room-state', onState);
  });
}

test('two players share keeper movement and resolve a save', { timeout: 15000 }, async () => {
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, resolve));
  const { port } = portProbe.address();
  await new Promise(resolve => portProbe.close(resolve));

  const url = `http://127.0.0.1:${port}`;
  const serverProcess = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore'
  });
  let striker;
  let keeper;

  try {
    const response = await waitForServer(url);
    assert.match(await response.text(), /Создать матч/);

    striker = await connectClient(url);
    keeper = await connectClient(url);

    const created = await new Promise(resolve => striker.emit('create-room', { name: 'Нападающий' }, resolve));
    assert.equal(created.ok, true);
    assert.equal(created.role, 'striker');

    const joined = await new Promise(resolve => keeper.emit('join-room', { code: created.state.code, name: 'Вратарь' }, resolve));
    assert.equal(joined.ok, true);
    assert.equal(joined.role, 'keeper');
    assert.equal(joined.state.phase, 'aiming');

    const movement = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Keeper movement was not broadcast')), 3000);
      striker.once('keeper-position', position => {
        clearTimeout(timer);
        resolve(position);
      });
    });
    keeper.emit('move-keeper', { x: 23, y: 65 });
    assert.deepEqual(await movement, { x: 23, y: 65 });

    const result = waitForRoomPhase(striker, 'result');
    striker.emit('shoot', { x: 23, y: 65, power: 1 });
    const room = await result;
    assert.equal(room.result.saved, true);
    assert.equal(room.shots.length, 1);
  } finally {
    striker?.disconnect();
    keeper?.disconnect();
    if (serverProcess.exitCode === null) {
      const stopped = once(serverProcess, 'exit');
      serverProcess.kill('SIGTERM');
      await stopped;
    }
  }
});
