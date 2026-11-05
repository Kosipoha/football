const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const path = require('node:path');
const { Server } = require('socket.io');

const root = __dirname;
const port = Number(process.env.PORT) || 3000;
const rooms = new Map();
const httpServer = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/client.js': ['client.js', 'text/javascript; charset=utf-8']
  };
  const file = files[pathname];
  if (!file) {
    response.writeHead(404).end('Not found');
    return;
  }
  try {
    const content = await readFile(path.join(root, file[0]));
    response.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
    response.end(content);
  } catch {
    response.writeHead(500).end('Could not load game');
  }
});
const io = new Server(httpServer);

function cleanName(value) {
  const name = String(value || '').trim().replace(/[<>]/g, '').slice(0, 14);
  return name || 'Игрок';
}

function newCode() {
  let code;
  do {
    code = randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function publicState(room) {
  return {
    code: room.code,
    players: Object.fromEntries(Object.entries(room.players).map(([role, player]) => [
      role,
      player ? { name: player.name, connected: Boolean(player.socketId) } : null
    ])),
    phase: room.phase,
    keeper: room.keeper,
    shot: room.shot,
    shots: room.shots,
    result: room.result
  };
}

function broadcast(room) {
  io.to(room.code).emit('room-state', publicState(room));
}

function detach(socket) {
  const { roomCode, role } = socket.data;
  if (!roomCode) return;
  const room = rooms.get(roomCode);
  if (room && room.players[role]?.socketId === socket.id) {
    room.players[role].socketId = null;
    if (!room.players.striker?.socketId || !room.players.keeper?.socketId) {
      if (room.phase === 'aiming') room.phase = 'waiting';
    }
    broadcast(room);
  }
  socket.leave(roomCode);
  socket.data.roomCode = null;
  socket.data.role = null;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Number(value) || 0));
}

function matchIsOver(room) {
  const goals = room.shots.filter(shot => !shot.saved).length;
  const saves = room.shots.length - goals;
  const remaining = 5 - room.shots.length;
  if (room.shots.length < 5) return goals > saves + remaining || saves > goals + remaining;
  return goals !== saves;
}

function finishShot(room, shotId) {
  if (room.phase !== 'flying' || room.shot?.id !== shotId) return;
  const shot = room.shot;
  const keeper = room.keeper;
  const distance = Math.hypot((keeper.x - shot.x) * 0.85, (keeper.y - shot.y) * 1.15);
  const saved = distance <= 16 - shot.power * 2;
  room.result = { saved, shot };
  room.shots.push({ saved });
  room.phase = 'result';
  broadcast(room);

  if (matchIsOver(room)) {
    room.phase = 'finished';
    broadcast(room);
    return;
  }

  room.nextRoundTimer = setTimeout(() => {
    room.shot = null;
    room.result = null;
    room.phase = room.players.striker?.socketId && room.players.keeper?.socketId ? 'aiming' : 'waiting';
    room.keeper = { x: 50, y: 76 };
    broadcast(room);
  }, 1700);
}

io.on('connection', socket => {
  socket.data.roomCode = null;
  socket.data.role = null;

  socket.on('create-room', (payload = {}, callback = () => {}) => {
    detach(socket);
    const code = newCode();
    const room = {
      code,
      players: {
        striker: { socketId: socket.id, name: cleanName(payload.name) },
        keeper: null
      },
      phase: 'waiting',
      keeper: { x: 50, y: 76 },
      shot: null,
      shots: [],
      result: null,
      nextRoundTimer: null,
      shotId: 0
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = 'striker';
    callback({ ok: true, role: 'striker', state: publicState(room) });
    broadcast(room);
  });

  socket.on('join-room', (payload = {}, callback = () => {}) => {
    const code = String(payload.code || '').trim().toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      callback({ ok: false, error: 'Комната не найдена. Проверьте код.' });
      return;
    }
    const role = !room.players.striker?.socketId ? 'striker' : !room.players.keeper?.socketId ? 'keeper' : null;
    if (!role) {
      callback({ ok: false, error: 'В комнате уже два игрока.' });
      return;
    }

    detach(socket);
    room.players[role] = { socketId: socket.id, name: cleanName(payload.name) };
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.role = role;
    if (room.players.striker?.socketId && room.players.keeper?.socketId && room.phase === 'waiting') {
      room.phase = 'aiming';
    }
    callback({ ok: true, role, state: publicState(room) });
    broadcast(room);
  });

  socket.on('move-keeper', (position = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'keeper' || !['aiming', 'flying'].includes(room.phase)) return;
    room.keeper = { x: clamp(position.x, 6, 94), y: clamp(position.y, 22, 88) };
    io.to(room.code).emit('keeper-position', room.keeper);
  });

  socket.on('shoot', (target = {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'striker' || room.phase !== 'aiming') return;
    const power = Math.round(clamp(target.power, 1, 3));
    const duration = 950 - power * 120;
    room.shot = {
      id: ++room.shotId,
      x: clamp(target.x, 8, 92),
      y: clamp(target.y, 10, 90),
      power,
      duration
    };
    room.result = null;
    room.phase = 'flying';
    broadcast(room);
    const shotId = room.shot.id;
    setTimeout(() => finishShot(room, shotId), duration);
  });

  socket.on('restart-match', () => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || socket.data.role !== 'striker') return;
    if (room.nextRoundTimer) clearTimeout(room.nextRoundTimer);
    room.shots = [];
    room.shot = null;
    room.result = null;
    room.keeper = { x: 50, y: 76 };
    room.phase = room.players.striker?.socketId && room.players.keeper?.socketId ? 'aiming' : 'waiting';
    broadcast(room);
  });

  socket.on('disconnect', () => detach(socket));
});

httpServer.listen(port, '0.0.0.0', () => {
  console.log(`Penalty Duel is listening on port ${port}`);
});
