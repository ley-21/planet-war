'use strict';
/*
 * 행성 점령전 — 멀티플레이 서버 (오라룩스 스타일 실시간 전략)
 * - 6자리 숫자 방 코드, 전원 준비완료 시 시작, 1~30명
 * - 1명: 일직선 5행성, 반대편에 AI / 2명: 같은 맵에서 사람 vs 사람
 * - 3명 이상: 중앙 행성 + N각형 꼭짓점에 각자 본진 + 나머지 행성 랜덤
 */
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { perMessageDeflate: false, pingTimeout: 20000 });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.send('ok'));

// ───────── 설정값 ─────────
const PORT = process.env.PORT || 3000;
const TICK_RATE = 20;
const MAX_PLAYERS = 30;
const ROUND_SECONDS = Number(process.env.ROUND_SECONDS) || 600; // 10분 제한
const COUNTDOWN = 3;
const FLEET_SPEED = 90;          // 유닛 이동 속도 (px/초)
const START_UNITS = 5;           // 시작 유닛 수
const AI_THINK_SECONDS = 1.2;    // AI가 판단하는 간격

// 행성 크기: 1=작음(최대 1레벨), 2=중간(최대 2레벨), 3=큼(최대 3레벨)
const RADIUS = [0, 22, 30, 40];
const capCost = (size) => [0, 10, 15, 20][size];        // 중립 점령에 필요한 유닛 (최소 10)
const upCost = (level) => 10 * (level + 1);             // 다음 레벨까지 필요한 유닛 (20, 30)
const hpMax = (level) => 5 + 10 * level;                // 행성 내구도 (15/25/35)
const garCap = (level) => 40 + 40 * level;              // 행성당 최대 보유 유닛 (넘으면 생산 중지)
// 생산 속도: 레벨당 초당 1개 (1레벨=1초에 1개, 2레벨=2개, 3레벨=3개)

const rooms = new Map();

function sanitizeName(n) {
  n = String(n || '').replace(/[<>&"']/g, '').trim().slice(0, 12);
  return n || '익명';
}
function pickHue(room) {
  const used = new Set([...room.players.values()].map((p) => p.hue));
  for (let i = 0; i < 60; i++) {
    const h = Math.round((i * 137.508 + 200) % 360);
    if (!used.has(h)) return h;
  }
  return Math.floor(Math.random() * 360);
}
function lobbyPayload(room) {
  return {
    code: room.code, state: room.state, countdown: room.countdown, max: MAX_PLAYERS,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, hue: p.hue, ready: p.ready, waiting: p.waiting })),
  };
}
function sendLobby(room) { io.to(room.code).emit('lobby', lobbyPayload(room)); }

function startPayload(room) {
  const g = room.game;
  return {
    roundSeconds: ROUND_SECONDS,
    planets: g.planets.map((p) => [p.id, Math.round(p.x), Math.round(p.y), p.size, p.r]),
    players: g.players.map((p) => ({ pi: p.pi, id: p.id, name: p.name, hue: p.hue, ai: p.ai })),
  };
}

// ───────── 소켓 ─────────
io.on('connection', (socket) => {
  let room = null;

  socket.on('join', (data, ack) => {
    ack = typeof ack === 'function' ? ack : () => {};
    const code = String((data && data.code) || '').trim();
    if (!/^\d{6}$/.test(code)) return ack({ ok: false, error: '방 코드는 숫자 6자리로 입력해 주세요.' });
    if (room) leaveRoom();
    let r = rooms.get(code);
    if (!r) {
      r = { code, players: new Map(), state: 'lobby', countdown: null, countdownTimer: null, game: null };
      rooms.set(code, r);
    }
    if (r.players.size >= MAX_PLAYERS) return ack({ ok: false, error: `방이 가득 찼어요 (최대 ${MAX_PLAYERS}명).` });
    const p = { id: socket.id, name: sanitizeName(data.name), hue: pickHue(r), ready: false, waiting: r.state === 'playing', socket };
    r.players.set(socket.id, p);
    room = r;
    socket.join(code);
    ack({ ok: true, id: socket.id, code });
    if (r.state === 'playing' && r.game) socket.emit('start', startPayload(r));
    sendLobby(r);
  });

  socket.on('ready', (v) => {
    if (!room || room.state !== 'lobby') return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.ready = !!v;
    checkStart(room);
    sendLobby(room);
  });

  // 유닛 보내기: { to: 행성id, src: [[행성id, 개수], ...] }
  socket.on('send', (d) => {
    if (!room || !room.game || !d) return;
    const g = room.game;
    const gp = g.players.find((q) => q.id === socket.id);
    if (!gp || !gp.alive) return;
    const to = g.planets[d.to | 0];
    if (!to || !Array.isArray(d.src)) return;
    for (const item of d.src.slice(0, 200)) {
      if (!Array.isArray(item)) continue;
      const from = g.planets[item[0] | 0];
      const n = Math.floor(Number(item[1]));
      if (!from || from.owner !== gp.pi || !(n > 0)) continue;
      sendUnits(g, from, to, Math.min(n, from.gar));
    }
  });

  socket.on('leave', () => leaveRoom());
  socket.on('disconnect', () => leaveRoom());

  function leaveRoom() {
    if (!room) return;
    const r = room;
    room = null;
    socket.leave(r.code);
    r.players.delete(socket.id);
    if (r.game) {
      const gp = r.game.players.find((q) => q.id === socket.id);
      if (gp && gp.alive) {                       // 나간 사람의 행성은 중립으로
        for (const p of r.game.planets) if (p.owner === gp.pi) makeNeutral(p);
        r.game.fleets = r.game.fleets.filter((f) => f.owner !== gp.pi);
      }
    }
    if (r.players.size === 0) {
      if (r.countdownTimer) clearInterval(r.countdownTimer);
      rooms.delete(r.code);
      return;
    }
    checkStart(r);
    sendLobby(r);
  }
});

function cancelCountdown(r) {
  if (r.countdownTimer) clearInterval(r.countdownTimer);
  r.countdownTimer = null;
  r.countdown = null;
}
function checkStart(r) {
  if (r.state !== 'lobby') return;
  const allReady = r.players.size > 0 && [...r.players.values()].every((p) => p.ready);
  if (allReady && r.countdown === null) {
    r.countdown = COUNTDOWN;
    r.countdownTimer = setInterval(() => {
      r.countdown--;
      if (r.countdown <= 0) { cancelCountdown(r); startGame(r); } else sendLobby(r);
    }, 1000);
  } else if (!allReady && r.countdown !== null) cancelCountdown(r);
}

// ───────── 맵 만들기 ─────────
function makePlanet(list, x, y, size) {
  const p = { id: list.length, x, y, size, r: RADIUS[size], owner: -1, level: 1, gar: 0, hp: 0, up: 0, cap: 0, capBy: -1, prod: 0 };
  list.push(p);
  return p;
}
function farEnough(list, x, y, r, gap) {
  for (const p of list) if (Math.hypot(p.x - x, p.y - y) < p.r + r + gap) return false;
  return true;
}

function makeMap(n) {
  const planets = [];
  const homes = [];
  if (n <= 2) {
    // 일직선 5개: [본진] - 중간 - 큰 중앙 - 중간 - [본진]
    const xs = [-640, -320, 0, 320, 640], sizes = [3, 2, 3, 2, 3];
    xs.forEach((x, i) => makePlanet(planets, x, 0, sizes[i]));
    homes.push(planets[0], planets[4]);
  } else {
    // 중앙 행성 + N각형 꼭짓점에 본진
    const Rh = Math.max(520, n * 80);
    makePlanet(planets, 0, 0, 3);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / n;
      homes.push(makePlanet(planets, Math.cos(a) * Rh, Math.sin(a) * Rh, 3));
    }
    // 나머지 행성은 랜덤 배치 (인원 × 2.5개 정도)
    const extra = Math.round(n * 2.5) + 2;
    let placed = 0, tries = 0;
    while (placed < extra && tries < extra * 200) {
      tries++;
      const a = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * Rh * 1.12;
      const x = Math.cos(a) * d, y = Math.sin(a) * d;
      const roll = Math.random();
      const size = roll < 0.5 ? 1 : roll < 0.85 ? 2 : 3;
      if (!farEnough(planets, x, y, RADIUS[size], 70)) continue;
      makePlanet(planets, x, y, size);
      placed++;
    }
  }
  return { planets, homes };
}

function makeNeutral(p) {
  p.owner = -1; p.level = 1; p.gar = 0; p.hp = 0; p.up = 0; p.cap = 0; p.capBy = -1; p.prod = 0;
}

// ───────── 게임 시작 ─────────
function startGame(r) {
  r.state = 'playing';
  const humans = [...r.players.values()];
  const players = humans.map((p, i) => ({ pi: i, id: p.id, name: p.name, hue: p.hue, ai: false, alive: true, elimOrder: 0, aiTimer: 0 }));
  if (players.length === 1) {
    const usedHue = players[0].hue;
    players.push({ pi: 1, id: 'AI', name: '🤖 AI', hue: (usedHue + 180) % 360, ai: true, alive: true, elimOrder: 0, aiTimer: 0 });
  }
  const { planets, homes } = makeMap(players.length);
  // 본진 순서를 섞어서 매번 자리가 바뀌게
  const order = players.map((_, i) => i).sort(() => Math.random() - 0.5);
  players.forEach((pl, k) => {
    const h = homes[order[k]];
    h.owner = pl.pi; h.level = 1; h.hp = hpMax(1); h.gar = START_UNITS;
  });
  r.game = { planets, players, fleets: [], nextFleet: 1, tick: 0, endTick: ROUND_SECONDS * TICK_RATE, elimCount: 0 };
  for (const p of humans) { p.waiting = false; p.ready = false; }
  io.to(r.code).emit('start', startPayload(r));
  sendLobby(r);
}

// ───────── 규칙 ─────────
function sendUnits(g, from, to, n) {
  if (n <= 0) return;
  from.gar -= n;
  if (from === to) { arrive(g, to, from.owner, n); return; }   // 자기 행성 클릭 = 업그레이드/회복에 사용
  const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1;
  g.fleets.push({
    id: g.nextFleet++, owner: from.owner, n, to: to.id,
    x: from.x + (dx / d) * (from.r + 6), y: from.y + (dy / d) * (from.r + 6),
  });
}

// 유닛이 행성에 도착했을 때
function arrive(g, p, owner, n) {
  if (n <= 0) return;
  if (p.owner === owner) {
    const heal = Math.min(hpMax(p.level) - p.hp, n);     // 1) 내구도 회복
    p.hp += heal; n -= heal;
    if (p.level < p.size && n > 0) {                      // 2) 업그레이드
      const u = Math.min(upCost(p.level) - p.up, n);
      p.up += u; n -= u;
      if (p.up >= upCost(p.level)) { p.level++; p.up = 0; p.hp = hpMax(p.level); }
    }
    p.gar += n;                                           // 3) 남으면 주둔
    return;
  }
  if (p.owner !== -1) {                                   // 적 행성
    const k = Math.min(p.gar, n);                         // 주둔 유닛과 1:1 상쇄
    p.gar -= k; n -= k;
    if (n <= 0) return;
    const dmg = Math.min(p.hp, n);                        // 남은 유닛으로 내구도 공격
    p.hp -= dmg; n -= dmg;
    if (p.hp > 0) return;
    makeNeutral(p);                                       // 내구도 0 → 중립이 됨
    if (n <= 0) return;
  }
  // 중립 행성 점령
  if (p.capBy !== -1 && p.capBy !== owner) {              // 다른 사람이 점령 중이면 그 진행도부터 깎음
    const k = Math.min(p.cap, n);
    p.cap -= k; n -= k;
    if (p.cap <= 0) { p.cap = 0; p.capBy = -1; }
    if (n <= 0) return;
  }
  p.capBy = owner;
  p.cap += n;
  const cost = capCost(p.size);
  if (p.cap >= cost) {
    const extra = p.cap - cost;
    makeNeutral(p);
    p.owner = owner; p.hp = hpMax(1);
    arrive(g, p, owner, extra);
  }
}

function tickGame(r) {
  const g = r.game;
  g.tick++;
  const dt = 1 / TICK_RATE;

  // 생산
  for (const p of g.planets) {
    if (p.owner < 0) continue;
    if (p.gar >= garCap(p.level)) { p.prod = 0; continue; }
    p.prod += p.level * dt;
    while (p.prod >= 1) { p.prod -= 1; p.gar++; }
  }

  // 이동 + 도착
  const step = FLEET_SPEED * dt;
  for (const f of g.fleets) {
    const t = g.planets[f.to];
    const dx = t.x - f.x, dy = t.y - f.y, d = Math.hypot(dx, dy);
    if (d <= t.r + step) { arrive(g, t, f.owner, f.n); f.n = 0; continue; }
    f.x += (dx / d) * step;
    f.y += (dy / d) * step;
  }
  g.fleets = g.fleets.filter((f) => f.n > 0);

  // 이동 중에 적 유닛 무리와 만나면 1:1 상쇄
  const fl = g.fleets;
  for (let i = 0; i < fl.length; i++) {
    const a = fl[i];
    if (a.n <= 0) continue;
    for (let j = i + 1; j < fl.length; j++) {
      const b = fl[j];
      if (b.n <= 0 || b.owner === a.owner) continue;
      const rr = 8 + Math.sqrt(a.n) * 1.5 + Math.sqrt(b.n) * 1.5;
      const dx = a.x - b.x, dy = a.y - b.y;
      if (dx * dx + dy * dy < rr * rr) {
        const k = Math.min(a.n, b.n);
        a.n -= k; b.n -= k;
        if (a.n <= 0) break;
      }
    }
  }
  g.fleets = g.fleets.filter((f) => f.n > 0);

  // AI
  for (const pl of g.players) if (pl.ai && pl.alive) runAI(g, pl);

  // 탈락 체크: 행성도 없고 이동 중인 유닛도 없으면 탈락
  for (const pl of g.players) {
    if (!pl.alive) continue;
    const has = g.planets.some((p) => p.owner === pl.pi) || g.fleets.some((f) => f.owner === pl.pi);
    if (!has) {
      pl.alive = false;
      pl.elimOrder = ++g.elimCount;
      io.to(r.code).emit('elim', { name: pl.name, hue: pl.hue });
    }
  }

  const aliveN = g.players.filter((p) => p.alive).length;
  if (aliveN <= 1 || g.tick >= g.endTick) { endGame(r); return; }
  broadcast(r);
}

// ───────── AI (1인 모드) ─────────
function runAI(g, ai) {
  ai.aiTimer -= 1 / TICK_RATE;
  if (ai.aiTimer > 0) return;
  ai.aiTimer = AI_THINK_SECONDS * (0.8 + Math.random() * 0.4);

  const mine = g.planets.filter((p) => p.owner === ai.pi);
  // 1) 업그레이드할 수 있으면 업그레이드
  for (const p of mine) {
    if (p.level < p.size && p.hp >= hpMax(p.level)) {
      const need = upCost(p.level) - p.up;
      if (p.gar >= need + 4) { sendUnits(g, p, p, need); }
    }
  }
  // 2) 이길 수 있는 목표 중 가장 가까운/싼 곳 공격
  for (const p of mine) {
    if (p.gar < 8) continue;
    let best = null, bestScore = Infinity, bestNeed = 0;
    for (const t of g.planets) {
      if (t.owner === ai.pi) continue;
      let need;
      if (t.owner === -1) need = capCost(t.size) - (t.capBy === ai.pi ? t.cap : -t.cap);
      else need = t.gar + t.hp + t.level * 2 + Math.round(Math.hypot(t.x - p.x, t.y - p.y) / FLEET_SPEED) * t.level;
      // 이미 보내고 있는 유닛은 빼고 계산
      for (const f of g.fleets) if (f.owner === ai.pi && f.to === t.id) need -= f.n;
      if (need <= 0) continue;
      need += 3;
      if (need > p.gar - 2) continue;
      const score = need + Math.hypot(t.x - p.x, t.y - p.y) / 25;
      if (score < bestScore) { bestScore = score; best = t; bestNeed = need; }
    }
    if (best) sendUnits(g, p, best, Math.min(p.gar, bestNeed));
  }
  // 3) 후방 행성에 유닛이 너무 많이 쌓이면 가장 앞선 행성으로 모으기
  if (mine.length > 1) {
    const enemy = g.planets.filter((t) => t.owner !== ai.pi && t.owner !== -1);
    if (enemy.length) {
      const distToEnemy = (p) => Math.min(...enemy.map((e) => Math.hypot(e.x - p.x, e.y - p.y)));
      const front = mine.reduce((a, b) => (distToEnemy(a) < distToEnemy(b) ? a : b));
      for (const p of mine) {
        if (p !== front && p.gar >= garCap(p.level) * 0.8) sendUnits(g, p, front, Math.floor(p.gar * 0.6));
      }
    }
  }
}

// ───────── 전송 ─────────
function broadcast(r) {
  const g = r.game;
  const msg = {
    t: g.tick,
    tl: Math.max(0, Math.ceil((g.endTick - g.tick) / TICK_RATE)),
    // 행성: [주인, 레벨, 주둔유닛, 내구도, 업그레이드진행, 점령진행, 점령중인사람]
    p: g.planets.map((p) => [p.owner, p.level, p.gar, p.hp, p.up, p.cap, p.capBy]),
    // 이동 중 유닛 무리: [id, 주인, 개수, x, y]
    f: g.fleets.map((f) => [f.id, f.owner, f.n, Math.round(f.x), Math.round(f.y)]),
  };
  if (g.tick % 10 === 0) msg.al = g.players.map((p) => (p.alive ? 1 : 0));
  io.to(r.code).volatile.emit('state', msg);
}

function scoreOf(g, pl) {
  let s = 0;
  for (const p of g.planets) if (p.owner === pl.pi) s += p.gar + p.level * 15;
  for (const f of g.fleets) if (f.owner === pl.pi) s += f.n;
  return s;
}

function endGame(r) {
  const g = r.game;
  const list = g.players.map((pl) => ({ pl, score: scoreOf(g, pl), planets: g.planets.filter((p) => p.owner === pl.pi).length }));
  list.sort((a, b) => {
    if (a.pl.alive !== b.pl.alive) return a.pl.alive ? -1 : 1;
    if (a.pl.alive) return b.score - a.score;
    return b.pl.elimOrder - a.pl.elimOrder;
  });
  const ranking = list.map((x, i) => ({
    rank: i + 1, id: x.pl.id, name: x.pl.name, hue: x.pl.hue, ai: x.pl.ai,
    alive: x.pl.alive, planets: x.planets, score: x.score,
  }));
  const timeUp = g.tick >= g.endTick;
  r.state = 'lobby';
  r.game = null;
  for (const p of r.players.values()) { p.ready = false; p.waiting = false; }
  io.to(r.code).emit('gameover', { ranking, timeUp });
  sendLobby(r);
}

setInterval(() => {
  for (const r of rooms.values()) {
    if (r.state === 'playing' && r.game) {
      try { tickGame(r); } catch (e) { console.error('tick error', e); }
    }
  }
}, 1000 / TICK_RATE);

server.listen(PORT, () => console.log(`🪐 행성 점령전 서버 실행 중: http://localhost:${PORT}`));
