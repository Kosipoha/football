const socket = io();
const $ = id => document.getElementById(id);
const state = { role: null, room: null, aim: { x: 50, y: 52 }, power: 2, dragging: false, lastMove: 0, animatedShot: null };
const powerLabels = { 1: 'ТОЧНО', 2: 'СРЕДНЕ', 3: 'СИЛЬНО' };

function setConnection(text, connected = false) {
  $('connectionState').textContent = text;
  $('connectionState').classList.toggle('connected', connected);
}

function setMessage(text, accent = false) {
  $('statusText').textContent = text;
  $('statusText').classList.toggle('accent', accent);
}

function setRole(role, room) {
  state.role = role;
  state.room = room;
  $('lobby').classList.add('in-room');
  $('roleName').textContent = role === 'striker' ? 'НАПАДАЮЩИЙ' : 'ВРАТАРЬ';
  $('roomCodeDisplay').textContent = room.code;
  $('roomBadge').hidden = false;
  $('strikerControls').hidden = role !== 'striker';
  $('keeperControls').hidden = role !== 'keeper';
  $('restartButton').hidden = role !== 'striker';
  $('strikerName').textContent = room.players.striker?.name || 'Ожидает игрока';
  $('keeperName').textContent = room.players.keeper?.name || 'Ожидает игрока';
  renderState(room);
}

function createRoom() {
  socket.emit('create-room', { name: $('playerName').value }, response => {
    if (!response?.ok) return setMessage(response?.error || 'Не удалось создать комнату');
    setRole(response.role, response.state);
    $('joinError').textContent = '';
  });
}

function joinRoom() {
  socket.emit('join-room', { code: $('roomCodeInput').value, name: $('playerName').value }, response => {
    if (!response?.ok) {
      $('joinError').textContent = response?.error || 'Не удалось войти';
      return;
    }
    $('joinError').textContent = '';
    setRole(response.role, response.state);
  });
}

function renderState(room) {
  state.room = room;
  $('strikerName').textContent = room.players.striker?.name || 'Ожидает игрока';
  $('keeperName').textContent = room.players.keeper?.name || 'Ожидает игрока';
  $('strikerOnline').classList.toggle('online', Boolean(room.players.striker?.connected));
  $('keeperOnline').classList.toggle('online', Boolean(room.players.keeper?.connected));
  $('roomCodeDisplay').textContent = room.code;
  updateKeeper(room.keeper);
  renderScore(room.shots);

  const playing = Boolean(room.players.striker?.connected && room.players.keeper?.connected);
  $('phaseRibbon').textContent = room.phase === 'waiting' ? 'Ждём соперника' : room.phase === 'finished' ? 'Матч завершён' : state.role === 'striker' ? 'Ход нападающего' : 'Ход вратаря';
  $('phaseRibbon').classList.toggle('keeper-phase', state.role === 'keeper');
  $('shootButton').disabled = state.role !== 'striker' || room.phase !== 'aiming';
  $('goal').classList.toggle('keeper-active', state.role === 'keeper' && ['aiming', 'flying'].includes(room.phase));
  $('aimMarker').hidden = state.role !== 'striker' || room.phase !== 'aiming';
  $('powerSlider').disabled = state.role !== 'striker' || room.phase !== 'aiming';
  $('restartButton').disabled = state.role !== 'striker' || !playing;

  if (room.phase === 'waiting') {
    setMessage(playing ? 'Соединяем игроков…' : state.role === 'striker' ? 'Комната создана. Отправь код сопернику.' : 'Соперник отключился. Ждём возвращения…');
  } else if (room.phase === 'aiming') {
    setMessage(state.role === 'striker' ? 'Выбери точку на воротах и бей.' : 'Займи позицию. Нападающий выбирает удар.');
  } else if (room.phase === 'flying') {
    setMessage('Мяч летит к воротам…', true);
    if (room.shot && state.animatedShot !== room.shot.id) animateShot(room.shot);
  } else if (room.phase === 'result' || room.phase === 'finished') {
    if (room.result) showResult(room.result.saved);
    if (room.phase === 'finished') {
      const goals = room.shots.filter(shot => !shot.saved).length;
      const saves = room.shots.length - goals;
      setMessage(goals === saves ? 'Ничья по пенальти' : goals > saves ? `${room.players.striker?.name || 'Нападающий'} победил!` : `${room.players.keeper?.name || 'Вратарь'} победил!`, true);
    } else if (room.result) {
      setMessage(room.result.saved ? 'Сейв! Вратарь отбил удар.' : 'ГОЛ! Мяч в сетке.', true);
    }
  }
  $('roundLabel').textContent = room.shots.length < 5 ? `Удар ${room.shots.length + 1} / 5` : `Доп. удар ${room.shots.length - 4}`;
  if (room.phase === 'aiming') resetBall();
}

function renderScore(shots) {
  const goals = shots.filter(shot => !shot.saved).length;
  const saves = shots.length - goals;
  $('scoreStriker').textContent = goals;
  $('scoreKeeper').textContent = saves;
  $('rounds').innerHTML = Array.from({ length: Math.max(5, shots.length) }, (_, index) => {
    const shot = shots[index];
    return `<span class="round-dot${shot ? shot.saved ? ' saved' : ' goal' : index === shots.length ? ' active' : ''}" aria-label="${shot ? shot.saved ? 'Сейв' : 'Гол' : `Удар ${index + 1}`}"></span>`;
  }).join('');
  $('turnList').innerHTML = Array.from({ length: Math.max(5, shots.length) }, (_, index) => {
    const shot = shots[index];
    return `<div class="turn-row"><span class="turn-num">${String(index + 1).padStart(2, '0')}</span><span class="turn-name">${shot ? shot.saved ? 'Сейв вратаря' : 'Гол нападающего' : 'Ожидает удара'}</span><span class="turn-icon${shot ? shot.saved ? ' saved' : ' goal' : index === shots.length ? ' current' : ''}">${shot ? shot.saved ? '×' : '✓' : index === shots.length ? '·' : '—'}</span></div>`;
  }).join('');
}

function updateKeeper(position) {
  if (!position) return;
  $('keeper').style.left = `${position.x}%`;
  $('keeper').style.top = `${position.y}%`;
}

function setAimFromPointer(event) {
  const goalRect = $('goal').getBoundingClientRect();
  state.aim.x = Math.min(92, Math.max(8, ((event.clientX - goalRect.left) / goalRect.width) * 100));
  state.aim.y = Math.min(90, Math.max(10, ((event.clientY - goalRect.top) / goalRect.height) * 100));
  const sceneRect = $('scene').getBoundingClientRect();
  $('aimMarker').style.left = `${((goalRect.left + goalRect.width * state.aim.x / 100 - sceneRect.left) / sceneRect.width) * 100}%`;
  $('aimMarker').style.top = `${((goalRect.top + goalRect.height * state.aim.y / 100 - sceneRect.top) / sceneRect.height) * 100}%`;
}

function moveKeeperFromPointer(event) {
  const rect = $('goal').getBoundingClientRect();
  const position = {
    x: Math.min(94, Math.max(6, ((event.clientX - rect.left) / rect.width) * 100)),
    y: Math.min(88, Math.max(22, ((event.clientY - rect.top) / rect.height) * 100))
  };
  updateKeeper(position);
  const now = performance.now();
  if (now - state.lastMove > 24) {
    socket.emit('move-keeper', position);
    state.lastMove = now;
  }
}

function animateShot(shot) {
  state.animatedShot = shot.id;
  const goalRect = $('goal').getBoundingClientRect();
  const sceneRect = $('scene').getBoundingClientRect();
  const endX = ((goalRect.left + goalRect.width * shot.x / 100 - sceneRect.left) / sceneRect.width) * 100;
  const endY = ((goalRect.top + goalRect.height * shot.y / 100 - sceneRect.top) / sceneRect.height) * 100;
  const middleX = 50 + (endX - 50) * 0.48;
  const middleY = 87 + (endY - 87) * 0.48 - 13;
  const ball = $('ball');
  ball.hidden = false;
  ball.getAnimations().forEach(animation => animation.cancel());
  ball.animate([
    { left: '50%', top: '88%', transform: 'translate(-50%, -50%) scale(.62)' },
    { left: `${middleX}%`, top: `${middleY}%`, transform: 'translate(-50%, -50%) scale(1.05)', offset: 0.48 },
    { left: `${endX}%`, top: `${endY}%`, transform: 'translate(-50%, -50%) scale(1.5)' }
  ], { duration: shot.duration || 650, easing: 'cubic-bezier(.16,.68,.26,1)', fill: 'forwards' });
}

function resetBall() {
  const ball = $('ball');
  ball.getAnimations().forEach(animation => animation.cancel());
  ball.hidden = true;
  state.animatedShot = null;
  $('result').classList.remove('visible', 'saved');
}

function showResult(saved) {
  $('resultText').textContent = saved ? 'СЕЙВ!' : 'ГОЛ!';
  $('result').classList.toggle('saved', saved);
  $('result').classList.add('visible');
}

function shoot() {
  if (state.role !== 'striker' || state.room?.phase !== 'aiming') return;
  socket.emit('shoot', { ...state.aim, power: state.power });
  $('aimMarker').hidden = true;
  $('shootButton').disabled = true;
}

$('createRoomButton').addEventListener('click', createRoom);
$('joinRoomButton').addEventListener('click', joinRoom);
$('shootButton').addEventListener('click', shoot);
$('restartButton').addEventListener('click', () => socket.emit('restart-match'));
$('roomCodeInput').addEventListener('input', event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 6); });
$('roomCodeInput').addEventListener('keydown', event => { if (event.key === 'Enter') joinRoom(); });
$('copyRoomButton').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.room.code);
    $('copyRoomButton').textContent = 'СКОПИРОВАНО';
    setTimeout(() => { $('copyRoomButton').textContent = 'КОПИРОВАТЬ КОД'; }, 1200);
  } catch {
    $('joinError').textContent = `Код комнаты: ${state.room.code}`;
  }
});
$('powerSlider').addEventListener('input', event => {
  state.power = Number(event.target.value);
  $('powerValue').textContent = powerLabels[state.power];
});

$('goal').addEventListener('pointerdown', event => {
  if (state.role === 'keeper' && ['aiming', 'flying'].includes(state.room?.phase)) {
    state.dragging = true;
    $('goal').setPointerCapture(event.pointerId);
    moveKeeperFromPointer(event);
  } else if (state.role === 'striker' && state.room?.phase === 'aiming') {
    setAimFromPointer(event);
  }
});
$('goal').addEventListener('pointermove', event => {
  if (state.dragging && state.role === 'keeper') moveKeeperFromPointer(event);
});
$('goal').addEventListener('pointerup', event => {
  if (!state.dragging) return;
  state.dragging = false;
  moveKeeperFromPointer(event);
});
$('goal').addEventListener('pointercancel', () => { state.dragging = false; });

document.addEventListener('keydown', event => {
  if (state.role !== 'keeper' || !['aiming', 'flying'].includes(state.room?.phase)) return;
  const movement = { x: 0, y: 0 };
  if (event.key === 'ArrowLeft' || event.key.toLowerCase() === 'a') movement.x = -4;
  if (event.key === 'ArrowRight' || event.key.toLowerCase() === 'd') movement.x = 4;
  if (event.key === 'ArrowUp' || event.key.toLowerCase() === 'w') movement.y = -4;
  if (event.key === 'ArrowDown' || event.key.toLowerCase() === 's') movement.y = 4;
  if (!movement.x && !movement.y) return;
  event.preventDefault();
  const position = {
    x: Math.min(94, Math.max(6, Number.parseFloat($('keeper').style.left || '50') + movement.x)),
    y: Math.min(88, Math.max(22, Number.parseFloat($('keeper').style.top || '76') + movement.y))
  };
  updateKeeper(position);
  socket.emit('move-keeper', position);
});

socket.on('connect', () => setConnection('СЕРВЕР ПОДКЛЮЧЁН', true));
socket.on('disconnect', () => setConnection('СОЕДИНЕНИЕ ПОТЕРЯНО'));
socket.on('connect_error', () => setConnection('НЕТ СВЯЗИ С СЕРВЕРОМ'));
socket.on('room-state', room => {
  if (!state.role) return;
  renderState(room);
  if (room.phase === 'waiting') setConnection('ЖДЁМ СОПЕРНИКА', true);
  else setConnection('МАТЧ В РЕАЛЬНОМ ВРЕМЕНИ', true);
});
socket.on('keeper-position', updateKeeper);

$('powerValue').textContent = powerLabels[state.power];
