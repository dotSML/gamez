// PARTY SUITE — session server. No dependencies. In-memory rooms.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);
const LETTERS = 'BCDFGHKLMNPRSTVW'.split('');
const BATTERY = 22000, STEP = 1600, FLOOR = 6000, MAX_LIVES = 3, MAX_PLAYERS = 10;
const STOP_ROUNDS = 5, GO_GRACE = 45000, HOLD_CAP = 30000;
const PANIC_ROUNDS = 8, PANIC_COUNT = 1300, PANIC_WINDOW = 2200;
const COLORS = ['RED', 'BLUE', 'GREEN', 'YELLOW'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rooms = new Map();
const now = () => Date.now();
const rid = () => randomBytes(8).toString('hex');

/* ------------------------------ rooms ------------------------------ */

function createRoom() {
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  } while (rooms.has(code));
  const room = {
    code, hostId: null, phase: 'lobby', game: 'bomb', players: new Map(), order: [],
    feed: [], v: 0, winnerId: null, overText: '', waiters: [], touched: now(),
    bomb: { letter: 'A', turnId: null, deadline: 0, timeMs: BATTERY, used: new Set() },
    stop: {
      round: 0, targetMs: 0, order: [], base: [], idx: 0, running: false, runningPid: null,
      startedAt: 0, turnDeadline: 0, tries: [], roundWinner: null, lastRound: null
    },
    panic: {
      round: 0, word: 0, ink: 0, goAt: 0, deadline: 0,
      solvedBy: null, locked: [], lastRound: null
    },
    bonk: {
      round: 0, frame: 0, acc: 0, last: now(), startedAt: 0, roundEndsAt: 0,
      floorGone: false, over: false, roundWinner: null, bodies: new Map()
    },
    tanks: {
      round: 0, state: 'idle', over: false, map: [],
      units: new Map(), order: [], bullets: [], lastStep: 0,
      endsAt: 0, nextAt: 0, lastKill: null,
      winnerId: null, roundWinner: null, points: new Map()
    },
  };
  rooms.set(code, room);
  return room;
}

function view(room, pid) {
  const ps = room.order.map((id) => room.players.get(id)).filter(Boolean);
  const st = room.stop;
  const pn = room.panic;
  return {
    t: 'state', now: now(), v: room.v, code: room.code, phase: room.phase,
    game: room.game, hostId: room.hostId, youId: pid, winnerId: room.winnerId,
    overText: room.overText,
    players: ps.map((p) => ({
      id: p.id, name: p.name, score: p.score, lives: p.lives, live: p.live > 0
    })),
    bomb: {
      letter: room.bomb.letter, turnId: room.bomb.turnId,
      deadline: room.bomb.deadline, timeMs: room.bomb.timeMs
    },
    stop: {
      round: st.round, rounds: STOP_ROUNDS, targetMs: st.targetMs,
      order: st.order.slice(), idx: st.idx, running: st.running,
      runningPid: st.runningPid, tries: st.tries.slice(), lastRound: st.lastRound
    },
    panic: {
      round: pn.round, rounds: PANIC_ROUNDS, word: pn.word, ink: pn.ink,
      goAt: pn.goAt, deadline: pn.deadline, solvedBy: pn.solvedBy,
      settledAt: pn.settledAt, nextAt: pn.nextAt, locked: pn.locked.slice(),
      lastRound: pn.lastRound
    },
    bonk: {
      round: room.bonk.round, rounds: BONK_ROUNDS,
      startedAt: room.bonk.startedAt, roundEndsAt: room.bonk.roundEndsAt,
      state: room.bonk.state || 'live'
    },
    tanks: (() => {
      const t = room.tanks;
      const mine = t.units.get(pid);
      const units = [];
      for (const [id, u] of t.units) {
        units.push({
          id, x: Math.round(u.x * 100) / 100, y: Math.round(u.y * 100) / 100,
          hp: u.hp, alive: u.alive ? 1 : 0, dir: u.dir
        });
      }
      return {
        round: t.round, rounds: TK2_ROUNDS, state: t.state, over: !!t.over,
        cols: TK2_COLS, rows: TK2_ROWS,
        map: t.map.map((row) => row.join('')),
        units,
        bullets: t.bullets.map((b) => ({
          x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100,
          owner: b.owner
        })),
        nextAt: t.nextAt, endsAt: t.endsAt,
        left: Math.max(0, (t.endsAt || 0) - now()),
        winnerId: t.winnerId, roundWinner: t.roundWinner, lastKill: t.lastKill,
        you: mine
          ? { x: Math.round(mine.x * 100) / 100, y: Math.round(mine.y * 100) / 100,
              dir: mine.dir, hp: mine.hp, alive: mine.alive ? 1 : 0 }
          : null
      };
    })(),
    feed: room.feed.slice(-40)
  };
}

function say(room, k, name, text) {
  room.feed.push({ k, name, text, at: now() });
  if (room.feed.length > 80) room.feed = room.feed.slice(-60);
}

function broadcast(room) {
  room.v++;
  room.touched = now();
  for (const p of room.players.values()) {
    if (p.ws) wsText(p.ws, JSON.stringify(view(room, p.id)));
  }
  const held = room.waiters;
  room.waiters = [];
  for (const w of held) {
    clearTimeout(w.timer);
    if (!w.res.writableEnded) sendJSON(w.res, 200, view(room, w.pid));
  }
}

/* --------------------------- common helpers --------------------------- */

const awake = (p) => !!p && (p.live > 0 || now() - p.lastSeen < 4000);

const aliveList = (room) => room.order.filter((id) => {
  const p = room.players.get(id);
  return p && p.lives > 0;
});

function nextAwake(room, fromId, pool) {
  const list = pool.filter((id) => {
    const p = room.players.get(id);
    return p && p.lives > 0 && awake(p);
  });
  if (!list.length) return null;
  const i = list.indexOf(fromId);
  return i === -1 ? list[0] : list[(i + 1) % list.length];
}

/* ------------------------------ BOMB WORD ------------------------------ */

function pickLetter(room) {
  let L;
  do { L = LETTERS[randomInt(LETTERS.length)]; } while (L === room.bomb.letter);
  return L;
}

function bombPass(room) {
  const b = room.bomb;
  b.turnId = nextAwake(room, b.turnId, aliveList(room)) || aliveList(room)[0] || null;
  b.deadline = now() + b.timeMs;
}

function startBomb(room) {
  for (const p of room.players.values()) { p.score = 0; p.lives = MAX_LIVES; }
  const b = room.bomb;
  b.used.clear();
  b.timeMs = BATTERY;
  b.letter = pickLetter(room);
  room.phase = 'bomb';
  room.winnerId = null;
  room.overText = '';
  const alive = aliveList(room);
  b.turnId = alive[randomInt(alive.length)];
  b.deadline = now() + b.timeMs;
  say(room, 'sys', null, 'Bomb lit. Words of 4+ letters containing "' + b.letter + '". No repeats.');
  broadcast(room);
}

function explode(room) {
  const b = room.bomb;
  const p = room.players.get(b.turnId);
  if (p) {
    p.lives -= 1;
    say(room, 'boom', p.name, p.lives > 0 ? p.lives + ' ' + (p.lives === 1 ? 'life' : 'lives') + ' left' : 'OUT');
  }
  const alive = aliveList(room);
  if (alive.length <= 1) {
    room.phase = 'over';
    room.winnerId = alive[0] || null;
    b.turnId = null;
    b.deadline = 0;
    const w = room.winnerId && room.players.get(room.winnerId);
    room.overText = w ? w.score + ' words passed before the final blast.' : 'Everyone exploded. Impressive.';
    say(room, 'sys', null, w ? w.name + ' survives. Everyone else: ash.' : 'Nobody survived.');
    broadcast(room);
    return;
  }
  b.letter = pickLetter(room);
  b.timeMs = Math.max(FLOOR, b.timeMs - 800);
  bombPass(room);
  b.deadline = now() + b.timeMs + 700;
  broadcast(room);
}

function checkWord(room, raw) {
  const w = String(raw || '').trim().toLowerCase();
  if (!/^[a-z]{4,24}$/.test(w)) return 'One word, letters only, 4 or more.';
  if (!w.includes(room.bomb.letter.toLowerCase())) return 'Must contain "' + room.bomb.letter + '".';
  if (room.bomb.used.has(w)) return 'Already used.';
  return null;
}

function takeWord(room, p, raw) {
  const b = room.bomb;
  const w = String(raw).trim().toLowerCase();
  p.score += 1;
  b.used.add(w);
  say(room, 'word', p.name, w);
  b.timeMs = Math.max(FLOOR, b.timeMs - STEP);
  bombPass(room);
  broadcast(room);
}

/* ------------------------------ DEAD STOP ------------------------------ */

const stopTarget = () => 4000 + randomInt(81) * 100;
const stopTurnDeadline = () => now() + GO_GRACE;

function rotate(list, by) {
  if (!list.length) return [];
  const n = ((by % list.length) + list.length) % list.length;
  return list.slice(n).concat(list.slice(0, n));
}

function nextStopRound(room) {
  const st = room.stop;
  st.round += 1;
  st.targetMs = stopTarget();
  st.order = rotate(st.base, st.round - 1);
  st.idx = 0;
  st.tries = [];
  st.running = false;
  st.runningPid = null;
  st.startedAt = 0;
  st.turnDeadline = stopTurnDeadline();
  st.roundWinner = null;
  broadcast(room);
}

function startStop(room) {
  const st = room.stop;
  for (const p of room.players.values()) { p.score = 0; p.lives = MAX_LIVES; }
  room.phase = 'stop';
  room.winnerId = null;
  room.overText = '';
  st.base = room.order.filter((id) => room.players.has(id));
  for (let i = st.base.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [st.base[i], st.base[j]] = [st.base[j], st.base[i]];
  }
  st.lastRound = null;
  st.round = 0;
  say(room, 'sys', null, 'Dead Stop. One shot each per round. The clock is hidden.');
  nextStopRound(room);
}

function stopGo(room, p) {
  const st = room.stop;
  if (room.phase !== 'stop') return 'Not running.';
  if (st.order[st.idx] !== p.id) return 'Not your shot.';
  if (st.running) return 'Already running.';
  if (st.tries.some((t) => t.id === p.id)) return 'You already went this round.';
  st.running = true;
  st.runningPid = p.id;
  st.startedAt = now();
  st.turnDeadline = now() + HOLD_CAP + 5000;
  broadcast(room);
  return null;
}

function stopRecord(room, p, ms, forced) {
  const st = room.stop;
  const val = Math.max(0, Math.round(ms));
  const t = { id: p.id, name: p.name, ms: val, delta: Math.abs(val - st.targetMs), forced: !!forced };
  st.tries.push(t);
  st.running = false;
  st.runningPid = null;
  st.startedAt = 0;
  st.idx += 1;
  st.turnDeadline = stopTurnDeadline();
  say(room, 'try', p.name, (val / 1000).toFixed(2) + 's, off by ' + (t.delta / 1000).toFixed(2));
  if (st.idx >= st.order.length) finishStopRound(room);
  else broadcast(room);
}

function finishStopRound(room) {
  const st = room.stop;
  if (!st.tries.length) { nextStopRound(room); return; }
  const best = st.tries.reduce((a, b) => (b.delta < a.delta ? b : a), st.tries[0]);
  const winners = st.tries.filter((t) => t.delta === best.delta);
  for (const w of winners) {
    const pl = room.players.get(w.id);
    if (pl) pl.score += 1;
  }
  st.roundWinner = winners.map((w) => w.name).join(' & ');
  st.lastRound = {
    round: st.round, targetMs: st.targetMs, winner: st.roundWinner,
    tryList: st.tries.slice()
  };
  say(room, 'sys', null, st.roundWinner + ' closest to ' + (st.targetMs / 1000).toFixed(2) + 's.');
  if (st.round >= STOP_ROUNDS) {
    let top = [];
    let topScore = -1;
    for (const id of st.order) {
      const p = room.players.get(id);
      if (!p) continue;
      if (p.score > topScore) { topScore = p.score; top = [p]; }
      else if (p.score === topScore) top.push(p);
    }
    room.phase = 'over';
    room.winnerId = top.length === 1 ? top[0].id : null;
    room.overText = top.length === 1
      ? top[0].score + ' of ' + STOP_ROUNDS + ' rounds won.'
      : 'Dead heat: ' + top.map((p) => p.name).join(' & ') + ' on ' + topScore + '.';
    say(room, 'sys', null, top.length === 1 ? top[0].name + ' wins.' : 'Tie at the top.');
    broadcast(room);
    return;
  }
  st.roundWinner = null;
  nextStopRound(room);
}

/* ------------------------------ INK PANIC ------------------------------ */
/* Everyone taps at once. Word says one colour, ink is another.
   Tap the INK colour. First correct tap takes the round; a wrong tap locks
   you out of it. Eight rounds, fastest nerve wins. */

function panicDeal(room) {
  const pn = room.panic;
  const word = randomInt(COLORS.length);
  let ink;
  do { ink = randomInt(COLORS.length); } while (ink === word);
  pn.word = word;
  pn.ink = ink;
}

function newPanicRound(room) {
  const pn = room.panic;
  pn.round += 1;
  pn.solvedBy = null;
  pn.locked = [];
  pn.lastRound = null;
  pn.settledAt = 0;
  pn.nextAt = 0;
  panicDeal(room);
  pn.goAt = now() + 600;
  pn.deadline = pn.goAt + PANIC_WINDOW;
  broadcast(room);
}

function startPanic(room) {
  for (const p of room.players.values()) { p.score = 0; p.lives = MAX_LIVES; }
  room.phase = 'panic';
  room.winnerId = null;
  room.overText = '';
  room.panic.round = 0;
  say(room, 'sys', null, 'Ink Panic. Tap the INK colour, not the word. Wrong tap locks you out.');
  newPanicRound(room);
}

function panicTap(room, p, pick) {
  const pn = room.panic;
  if (room.phase !== 'panic') return 'Not running.';
  if (pn.solvedBy) return 'Round already taken.';
  if (pn.locked.includes(p.id)) return 'You are locked out of this round.';
  if (now() < pn.goAt) return 'Wait for GO.';
  if (now() > pn.deadline) return 'Too late.';
  const idx = COLORS.indexOf(String(pick || '').toUpperCase());
  if (idx === -1) return 'Unknown colour.';
  if (idx === pn.ink) {
    pn.solvedBy = p.id;
    pn.settledAt = now();
    pn.nextAt = pn.settledAt + 1100;
    p.score += 1;
    say(room, 'try', p.name, COLORS[pn.ink] + ' · took it in ' +
      ((pn.settledAt - pn.goAt) / 1000).toFixed(2) + 's');
    broadcast(room);
    return null;
  }
  pn.locked.push(p.id);
  say(room, 'miss', p.name, 'tapped ' + COLORS[idx] + ' · locked out');
  broadcast(room);
  return null;
}

function finishPanicRound(room) {
  const pn = room.panic;
  pn.deadline = 0;
  const winner = pn.solvedBy && room.players.get(pn.solvedBy);
  if (!winner) say(room, 'sys', null, 'Nobody got it. Round wasted.');
  if (pn.round >= PANIC_ROUNDS) {
    const list = room.order.map((id) => room.players.get(id)).filter(Boolean);
    let top = [];
    let topScore = -1;
    for (const q of list) {
      if (q.score > topScore) { topScore = q.score; top = [q]; }
      else if (q.score === topScore) top.push(q);
    }
    room.phase = 'over';
    room.winnerId = top.length === 1 ? top[0].id : null;
    room.overText = top.length === 1
      ? top[0].score + ' of ' + PANIC_ROUNDS + ' rounds taken.'
      : 'Dead heat: ' + top.map((q) => q.name).join(' & ') + ' on ' + topScore + '.';
    say(room, 'sys', null, top.length === 1 ? top[0].name + ' wins.' : 'Tie at the top.');
    broadcast(room);
    return;
  }
  pn.nextAt = now() + 1500;
  broadcast(room);
}
/* ------------------------------ BONK ARENA ------------------------------ */
/* Server-authoritative 2D physics. Everyone is a circle on a platform that
   loses tiles as the round runs. Last body above the floor takes the round.
   Best of three. 30 Hz fixed tick, 15 Hz snapshots. */

const BONK_W = 800, BONK_H = 600, BONK_FLOOR_Y = 470;
const BONK_G = 1900, BONK_SPEED = 340, BONK_JUMP = 700, BONK_R = 20;
const BONK_REST = 0.55, BONK_ROUNDS = 3, BONK_ROUND_MS = 30000;
const BONK_GAP_MS = 2600, BONK_TILES = 16;
const BONK_TW = BONK_W / BONK_TILES;
const BONK_DROP_EVERY = 55;      /* physics frames between tile drops, ~1.8s */
const BONK_DROP_START = 30;      /* first tile goes at ~1s */
const BONK_STEP_MS = 1000 / 30;

function bonkSpawn(room) {
  const b = room.bonk;
  const live = room.order.filter((id) => room.players.has(id));
  b.round += 1;
  b.frame = 0;
  b.acc = 0;
  b.last = now();
  b.over = false;
  b.state = 'live';
  b.roundWinner = null;
  b.startedAt = now();
  b.roundEndsAt = now() + BONK_ROUND_MS;
  b.removed = 0;
  const x0 = 0;
  b.floor = [];
  for (let i = 0; i < BONK_TILES; i++) {
    b.floor.push({ x: x0 + i * BONK_TW, w: BONK_TW, y: BONK_FLOOR_Y, dead: false });
  }
  b.bodies = new Map();
  for (let i = 0; i < live.length; i++) {
    const slot = (i + 0.5) / Math.max(1, live.length);
    b.bodies.set(live[i], {
      id: live[i],
      x: 60 + slot * (BONK_W - 120),
      y: BONK_FLOOR_Y - 60,
      vx: 0, vy: 0, r: BONK_R, alive: true, grounded: false,
      in: { l: 0, r: 0, j: 0 }
    });
  }
  say(room, 'sys', null, 'Round ' + b.round + '. Do not fall.');
  broadcast(room);
  bonkBroadcast(room);
}

function startBonk(room) {
  for (const p of room.players.values()) { p.score = 0; p.lives = 1; }
  room.phase = 'bonk';
  room.winnerId = null;
  room.overText = '';
  room.bonk.round = 0;
  say(room, 'sys', null, 'Bonk Arena. Shove everyone off. Best of ' + BONK_ROUNDS + '.');
  bonkSpawn(room);
}

function bonkStep(room, dt) {
  const b = room.bonk;
  const alive = [];
  for (const body of b.bodies.values()) if (body.alive) alive.push(body);

  for (const body of alive) {
    const dir = (body.in.r ? 1 : 0) - (body.in.l ? 1 : 0);
    const tv = dir * BONK_SPEED;
    body.vx += (tv - body.vx) * Math.min(1, dt * 16);
    if (!dir && body.grounded) body.vx *= Math.pow(0.015, dt);
    if (body.in.j && body.grounded) {
      body.vy = -BONK_JUMP;
      body.grounded = false;
    }
    body.in.j = 0;
    body.vy = Math.min(2600, body.vy + BONK_G * dt);

    const py = body.y;
    body.x += body.vx * dt;
    body.y += body.vy * dt;
    body.grounded = false;

    if (body.vy >= 0) {
      for (const t of b.floor) {
        if (t.dead) continue;
        if (body.x + body.r * 0.7 < t.x || body.x - body.r * 0.7 > t.x + t.w) continue;
        if (py + body.r <= t.y + 2 && body.y + body.r >= t.y) {
          body.y = t.y - body.r;
          body.vy = 0;
          body.grounded = true;
          break;
        }
      }
    }

    if (body.x < body.r) { body.x = body.r; body.vx = Math.abs(body.vx) * 0.35; }
    if (body.x > BONK_W - body.r) { body.x = BONK_W - body.r; body.vx = -Math.abs(body.vx) * 0.35; }
    if (body.y < -500) { body.y = -500; body.vy = 0; }
  }

  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const A = alive[i], B = alive[j];
      const dx = B.x - A.x, dy = B.y - A.y;
      const rr = A.r + B.r;
      const d2 = dx * dx + dy * dy;
      if (d2 >= rr * rr) continue;
      const d = Math.sqrt(d2) || 0.01;
      const nx = dx / d, ny = dy / d;
      const push = (rr - d) / 2;
      A.x -= nx * push; A.y -= ny * push;
      B.x += nx * push; B.y += ny * push;
      const vn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
      if (vn > 0) continue;
      const imp = (-(1 + BONK_REST) * vn) / 2;
      A.vx -= imp * nx; A.vy -= imp * ny;
      B.vx += imp * nx; B.vy += imp * ny;
      if (vn < -90) { A.vy -= 55; B.vy -= 55; }
    }
  }

  for (const body of alive) {
    if (body.y - body.r > BONK_H + 40) body.alive = false;
  }
}

function bonkDropTile(room) {
  const b = room.bonk;
  const open = b.floor.filter((t) => !t.dead);
  if (open.length <= 5) return;
  const pick = open[Math.floor(Math.random() * open.length)];
  pick.dead = true;
  b.removed += 1;
}

function bonkEndRound(room) {
  const b = room.bonk;
  const survivors = [...b.bodies.values()].filter((x) => x.alive);
  if (survivors.length === 0) {
    b.roundWinner = null;
    say(room, 'sys', null, 'Nobody survived. Round wasted.');
  } else if (survivors.length === 1) {
    const p = room.players.get(survivors[0].id);
    if (p) p.score += 1;
    b.roundWinner = p ? p.name : null;
    say(room, 'sys', null, (p ? p.name : 'Someone') + ' survived round ' + b.round + '.');
  } else {
    for (const s of survivors) {
      const p = room.players.get(s.id);
      if (p) p.score += 1;
    }
    b.roundWinner = survivors.map((s) => (room.players.get(s.id) || {}).name).filter(Boolean).join(' & ');
    say(room, 'sys', null, 'Clock ran out, survivors share it: ' + b.roundWinner);
  }
  b.state = 'gap';
  b.nextAt = now() + BONK_GAP_MS;
  if (b.round >= BONK_ROUNDS) {
    let top = [], best = -1;
    for (const id of room.order) {
      const p = room.players.get(id);
      if (!p) continue;
      if (p.score > best) { best = p.score; top = [p]; }
      else if (p.score === best) top.push(p);
    }
    b.over = true;
    room.phase = 'over';
    room.winnerId = top.length === 1 ? top[0].id : null;
    room.overText = top.length === 1
      ? top[0].score + ' of ' + BONK_ROUNDS + ' rounds survived.'
      : 'Dead heat: ' + top.map((p) => p.name).join(' & ') + ' on ' + best + '.';
    say(room, 'sys', null, top.length === 1 ? top[0].name + ' wins the arena.' : 'Tie at the top.');
  }
  broadcast(room);
  bonkBroadcast(room);
}

function bonkSnap(room) {
  const b = room.bonk;
  const bodies = [];
  for (const body of b.bodies.values()) {
    bodies.push([body.id, Math.round(body.x), Math.round(body.y), body.alive ? 1 : 0]);
  }
  const dead = [];
  for (let i = 0; i < b.floor.length; i++) if (b.floor[i].dead) dead.push(i);
  return {
    t: 'bk', v: room.v, round: b.round,
    left: b.state === 'gap' ? 0 : Math.max(0, b.roundEndsAt - now()),
    state: b.state, bodies, dead
  };
}

function bonkBroadcast(room) {
  const msg = JSON.stringify(bonkSnap(room));
  for (const p of room.players.values()) {
    if (p.ws) wsText(p.ws, msg);
  }
  room.lastSnap = now();
}

function bonkTick(room) {
  const b = room.bonk;
  if (b.over) return;
  if (b.state === 'gap') {
    if (now() > b.nextAt) bonkSpawn(room);
    return;
  }
  const dtMs = Math.min(250, now() - b.last);
  b.last = now();
  b.acc += dtMs;
  let guard = 0;
  while (b.acc >= BONK_STEP_MS && guard++ < 8) {
    b.acc -= BONK_STEP_MS;
    bonkStep(room, BONK_STEP_MS / 1000);
    b.frame += 1;
    if (b.frame >= BONK_DROP_START && (b.frame - BONK_DROP_START) % BONK_DROP_EVERY === 0) {
      bonkDropTile(room);
    }
  }
  const aliveCount = [...b.bodies.values()].filter((x) => x.alive).length;
  if (aliveCount <= 1 || now() > b.roundEndsAt) {
    bonkEndRound(room);
    return;
  }
  if (!room.lastSnap || now() - room.lastSnap >= 66) bonkBroadcast(room);
}

/* ------------------------------ TANKS ------------------------------ */
/* Classic top-down tank duel, Battle City style. A maze of brick and steel,
   four-way movement, bullets that chew through brick. Last tank running takes
   the round, best of three. The server owns every position and every bullet:
   a client can only ask to face a direction and to fire. */

const TK2_COLS = 25, TK2_ROWS = 19;
const TK2_SPEED = 4.4;          /* tiles per second */
const TK2_BULLET = 14;          /* tiles per second */
const TK2_FIRE_CD = 520;
const TK2_MAX_BULLETS = 2;
const TK2_DMG = 50;
const TK2_HP = 100;
const TK2_HALF = 0.38;          /* tank half-width, in tiles */
const TK2_ROUNDS = 3;
const TK2_ROUND_MS = 90000;
const TK2_GAP_MS = 3200;
const TK2_SUB = 1 / 240;

/* The arena. Built in code so the width can never be miscounted by hand. */
function tk2Map() {
  const g = [];
  for (let y = 0; y < TK2_ROWS; y++) g.push(new Array(TK2_COLS).fill('.'));
  const set = (x, y, v) => {
    if (x < 0 || y < 0 || x >= TK2_COLS || y >= TK2_ROWS) return;
    g[y][x] = v;
  };
  /* outer wall is indestructible */
  for (let x = 0; x < TK2_COLS; x++) { set(x, 0, 'S'); set(x, TK2_ROWS - 1, 'S'); }
  for (let y = 0; y < TK2_ROWS; y++) { set(0, y, 'S'); set(TK2_COLS - 1, y, 'S'); }

  /* blocks: [x, y, w, h, kind]. Brick chews away, steel does not. */
  const blocks = [
    [3, 3, 2, 2, 'B'], [20, 3, 2, 2, 'B'],
    [3, 14, 2, 2, 'B'], [20, 14, 2, 2, 'B'],
    [7, 2, 3, 1, 'B'], [15, 2, 3, 1, 'B'],
    [7, 16, 3, 1, 'B'], [15, 16, 3, 1, 'B'],
    [11, 6, 3, 1, 'S'], [11, 12, 3, 1, 'S'],
    [12, 9, 1, 1, 'S'],
    [6, 8, 1, 3, 'B'], [18, 8, 1, 3, 'B'],
    [12, 3, 1, 2, 'S'], [12, 14, 1, 2, 'S'],
    [3, 8, 2, 1, 'S'], [20, 10, 2, 1, 'S'],
    [9, 9, 1, 1, 'B'], [15, 9, 1, 1, 'B']
  ];
  for (const [bx, by, bw, bh, kind] of blocks) {
    for (let y = by; y < by + bh; y++) {
      for (let x = bx; x < bx + bw; x++) {
        if (g[y] && g[y][x] === '.') set(x, y, kind);
      }
    }
  }
  return g;
}

const tk2Solid = (t, x, y) => {
  const cx = Math.floor(x), cy = Math.floor(y);
  if (cx < 0 || cy < 0 || cx >= TK2_COLS || cy >= TK2_ROWS) return true;
  return t.map[cy][cx] !== '.';
};

/* A tank occupies a square. Free if it overlaps no wall and no other tank. */
function tk2Fits(t, x, y, skipId) {
  const h = TK2_HALF;
  if (x - h < 0 || y - h < 0 || x + h > TK2_COLS || y + h > TK2_ROWS) return false;
  for (let cy = Math.floor(y - h); cy <= Math.floor(y + h); cy++) {
    for (let cx = Math.floor(x - h); cx <= Math.floor(x + h); cx++) {
      if (cx < 0 || cy < 0 || cx >= TK2_COLS || cy >= TK2_ROWS) return false;
      if (t.map[cy][cx] !== '.') return false;
    }
  }
  for (const u of t.units.values()) {
    if (u.id === skipId || !u.alive) continue;
    if (Math.abs(u.x - x) < TK2_HALF * 2 && Math.abs(u.y - y) < TK2_HALF * 2) return false;
  }
  return true;
}

/* Spawn lanes: left and right, staggered so nobody starts nose to nose. */
const TK2_SPAWNS = [
  { x: 2.5, y: 9.5, dir: 1 },
  { x: 22.5, y: 9.5, dir: 3 },
  { x: 2.5, y: 2.5, dir: 2 },
  { x: 22.5, y: 16.5, dir: 0 },
  { x: 2.5, y: 16.5, dir: 0 },
  { x: 22.5, y: 2.5, dir: 2 },
  { x: 12.5, y: 2.5, dir: 2 },
  { x: 12.5, y: 16.5, dir: 0 }
];

function tk2NewRound(room) {
  const t = room.tanks;
  t.round += 1;
  t.state = 'live';
  t.map = tk2Map();
  t.units = new Map();
  t.bullets = [];
  t.lastKill = null;
  t.roundWinner = null;
  t.winnerId = null;
  t.endsAt = now() + TK2_ROUND_MS;
  t.nextAt = 0;
  t.order = room.order.filter((id) => room.players.has(id));

  const pool = TK2_SPAWNS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    const s = pool[i]; pool[i] = pool[j]; pool[j] = s;
  }
  t.order.forEach((id, i) => {
    const s = pool[i % pool.length];
    t.units.set(id, {
      id, x: s.x, y: s.y, dir: s.dir,
      hp: TK2_HP, alive: true, lastFire: 0, want: null
    });
  });
  say(room, 'sys', null, 'Round ' + t.round + '. Brick breaks. Steel does not.');
  broadcast(room);
}

function startTanks(room) {
  for (const p of room.players.values()) { p.score = 0; p.lives = MAX_LIVES; }
  room.phase = 'tanks';
  room.winnerId = null;
  room.overText = '';
  room.tanks.round = 0;
  room.tanks.over = false;
  room.tanks.points = new Map();
  for (const id of room.order) room.tanks.points.set(id, 0);
  say(room, 'sys', null, 'Tanks. Hold a direction to roll, tap fire to shoot.');
  tk2NewRound(room);
}

/* Turn to face a direction. Snapping the cross-axis to the lane centre is
   what makes the movement feel like a tank rather than a marble. */
function tk2Face(t, u, dir) {
  const want = ((dir % 4) + 4) % 4;
  if (u.dir === want) return;
  const ox = u.x, oy = u.y;
  if (want === 1 || want === 3) u.y = Math.floor(u.y) + 0.5;
  else u.x = Math.floor(u.x) + 0.5;
  if (!tk2Fits(t, u.x, u.y, u.id)) { u.x = ox; u.y = oy; }
  u.dir = want;
}

function tk2Move(room, u, dt) {
  const t = room.tanks;
  const dx = [0, 1, 0, -1][u.dir];
  const dy = [-1, 0, 1, 0][u.dir];
  let left = TK2_SPEED * dt;
  while (left > 0) {
    const step = Math.min(0.08, left);
    left -= step;
    const nx = u.x + dx * step, ny = u.y + dy * step;
    if (!tk2Fits(t, nx, ny, u.id)) break;
    u.x = nx; u.y = ny;
  }
}

function tk2Shoot(room, p) {
  const t = room.tanks;
  if (room.phase !== 'tanks') return 'Not running.';
  if (t.state !== 'live') return 'Between rounds.';
  const u = t.units.get(p.id);
  if (!u || !u.alive) return 'You are out of this round.';
  const tm = now();
  if (tm - u.lastFire < TK2_FIRE_CD) return null;
  const mine = t.bullets.filter((b) => b.owner === p.id);
  if (mine.length >= TK2_MAX_BULLETS) return null;
  u.lastFire = tm;
  const dx = [0, 1, 0, -1][u.dir];
  const dy = [-1, 0, 1, 0][u.dir];
  t.bullets.push({
    x: u.x + dx * 0.55, y: u.y + dy * 0.55,
    vx: dx * TK2_BULLET, vy: dy * TK2_BULLET,
    owner: p.id, age: 0
  });
  broadcast(room);
  return null;
}

function tk2Kill(room, victimId, byId) {
  const t = room.tanks;
  const v = t.units.get(victimId);
  if (!v || !v.alive) return;
  v.alive = false;
  v.hp = 0;
  const vp = room.players.get(victimId);
  const bp = byId ? room.players.get(byId) : null;
  t.lastKill = { victim: victimId, by: byId, at: now() };
  say(room, 'boom', bp ? bp.name : '?', (vp ? vp.name : '?') + ' destroyed');
}

function tk2Step(room, dt) {
  const t = room.tanks;
  if (t.state !== 'live') return;

  for (const u of t.units.values()) {
    if (!u.alive) continue;
    if (u.want !== null && u.want !== undefined) {
      if (u.dir !== u.want) tk2Face(t, u, u.want);
      tk2Move(room, u, dt);
    }
  }

  let left = Math.min(0.12, dt);
  let guard = 0;
  while (left > 0 && guard++ < 60) {
    const h = Math.min(TK2_SUB, left);
    left -= h;
    const keep = [];
    for (const b of t.bullets) {
      b.age += h;
      b.x += b.vx * h;
      b.y += b.vy * h;

      let dead = false;
      const cx = Math.floor(b.x), cy = Math.floor(b.y);
      const cell = (cx >= 0 && cy >= 0 && cx < TK2_COLS && cy < TK2_ROWS)
        ? t.map[cy][cx] : 'S';
      if (cell === 'B') { t.map[cy][cx] = '.'; dead = true; }
      else if (cell === 'S') { dead = true; }
      else if (cell !== '.' && cell !== undefined) { dead = true; }

      if (!dead) {
        for (const u of t.units.values()) {
          if (!u.alive || u.id === b.owner) continue;
          if (Math.abs(u.x - b.x) < TK2_HALF + 0.1 && Math.abs(u.y - b.y) < TK2_HALF + 0.1) {
            u.hp = Math.max(0, u.hp - TK2_DMG);
            if (u.hp <= 0) tk2Kill(room, u.id, b.owner);
            dead = true;
            break;
          }
        }
      }
      if (!dead && b.age > 4) dead = true;
      if (!dead) keep.push(b);
    }
    t.bullets = keep;
  }

  const alive = [...t.units.values()].filter((u) => u.alive);
  if (alive.length <= 1) { tk2Resolve(room); return; }
  if (now() >= t.endsAt) tk2Resolve(room, true);
}

function tk2Resolve(room, timedOut) {
  const t = room.tanks;
  if (t.state !== 'live') return;
  t.state = 'gap';

  const alive = [...t.units.values()].filter((u) => u.alive);
  let winner = null;
  if (alive.length === 1) winner = alive[0].id;
  else if (alive.length > 1) {
    alive.sort((a, b) => b.hp - a.hp);
    if (alive[0].hp > alive[1].hp) winner = alive[0].id;
  }

  const wp = winner ? room.players.get(winner) : null;
  t.winnerId = winner;
  t.roundWinner = wp ? wp.name : null;
  if (wp) {
    wp.score = (wp.score || 0) + 1;
    t.points.set(winner, (t.points.get(winner) || 0) + 1);
    say(room, 'sys', null, wp.name + ' takes round ' + t.round + (timedOut ? ' on time' : '') + '.');
  } else {
    say(room, 'sys', null, 'Round ' + t.round + ' drawn.');
  }

  if (t.round >= TK2_ROUNDS) {
    let top = [], best = -1;
    for (const id of room.order) {
      const q = room.players.get(id);
      if (!q) continue;
      const pts = t.points.get(id) || 0;
      if (pts > best) { best = pts; top = [q]; }
      else if (pts === best) top.push(q);
    }
    t.over = true;
    room.phase = 'over';
    room.winnerId = top.length === 1 ? top[0].id : null;
    room.overText = top.length === 1
      ? best + ' of ' + TK2_ROUNDS + ' rounds won.'
      : 'Dead heat: ' + top.map((q) => q.name).join(' & ') + ' on ' + best + '.';
    say(room, 'sys', null, top.length === 1 ? top[0].name + ' wins.' : 'Tie at the top.');
    broadcast(room);
    return;
  }
  t.nextAt = now() + TK2_GAP_MS;
  broadcast(room);
}

function tk2Tick(room) {
  if (room.phase !== 'tanks') return;
  const t = room.tanks;
  if (t.state === 'gap') {
    if (t.nextAt && now() > t.nextAt) tk2NewRound(room);
    return;
  }
  if (t.state !== 'live') return;

  const at = now();
  const dt = Math.min(0.12, (at - (t.lastStep || at)) / 1000);
  t.lastStep = at;

  /* Movement happens every tick but a client can only see what is sent, so
     push the field at 20 Hz while live. Without this nothing appears to move. */
  const moved = [...t.units.values()].some((u) => u.alive && u.want !== null && u.want !== undefined);

  if (dt > 0) tk2Step(room, dt);
  if (t.state !== 'live') return;   /* the step may have ended the round */

  if (moved || t.bullets.length || at - (t.lastPush || 0) >= 50) {
    t.lastPush = at;
    tk2Push(room);
  }
}

/* A lighter packet than the full room view: only what a frame needs. */
function tk2Push(room) {
  const t = room.tanks;
  const pkt = {
    t: 'tk',
    map: t.map.map((row) => row.join('')),
    units: [...t.units.values()].map((u) => ({
      id: u.id, x: Math.round(u.x * 100) / 100, y: Math.round(u.y * 100) / 100,
      dir: u.dir, hp: u.hp, alive: u.alive ? 1 : 0
    })),
    bullets: t.bullets.map((b) => ({
      x: Math.round(b.x * 100) / 100, y: Math.round(b.y * 100) / 100,
      vx: Math.round(b.vx * 10) / 10, vy: Math.round(b.vy * 10) / 10, owner: b.owner
    })),
    state: t.state, round: t.round, left: Math.max(0, (t.endsAt || 0) - now())
  };
  for (const p of room.players.values()) {
    if (p.ws) wsText(p.ws, JSON.stringify(pkt));
  }
  /* Long-poll clients have no socket to push down, so hand them the field
     here as well. Throttled: 20 Hz of HTTP would be a busy loop. */
  if (now() - (t.lastPoll || 0) >= 110 && room.waiters.length) {
    t.lastPoll = now();
    const held = room.waiters;
    room.waiters = [];
    for (const w of held) {
      clearTimeout(w.timer);
      if (!w.res.writableEnded) sendJSON(w.res, 200, pkt);
    }
  }
}

/* ------------------------------ http ------------------------------ */

const sendJSON = (res, code, obj) => {
  if (res.writableEnded) return;
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((ok) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 8192) s = s.slice(0, 8192); });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } });
    req.on('error', () => ok({}));
  });
}

function cleanName(raw, room) {
  let n = String(raw || '').replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 14);
  if (!n) n = 'Player';
  const taken = new Set([...room.players.values()].map((p) => p.name.toLowerCase()));
  if (taken.has(n.toLowerCase())) {
    let i = 2;
    while (taken.has((n + ' ' + i).toLowerCase())) i++;
    n = n + ' ' + i;
  }
  return n;
}

function hello(res, b) {
  let room;
  if (b.code) {
    room = rooms.get(String(b.code).toUpperCase());
    if (!room) return sendJSON(res, 404, { e: 'No session with that code.' });
  } else {
    room = createRoom();
  }
  let p = b.pid ? room.players.get(String(b.pid)) : null;
  if (!p || p.secret !== b.secret) {
    if (room.players.size >= MAX_PLAYERS) return sendJSON(res, 409, { e: 'That session is full (10).' });
    p = {
      id: rid(), secret: randomBytes(12).toString('hex'), name: cleanName(b.name, room),
      score: 0, lives: MAX_LIVES, ws: null, live: 0, lastSeen: now()
    };
    room.players.set(p.id, p);
    room.order.push(p.id);
    if (!room.hostId) room.hostId = p.id;
    room.touched = now();
    if (room.phase === 'bomb') {
      const alive = aliveList(room);
      if (alive.length === 1) { p.lives = MAX_LIVES; startBomb(room); }
      else broadcast(room);
    } else if (room.phase === 'stop') {
      room.stop.order.push(p.id);
      room.stop.base.push(p.id);
      broadcast(room);
    } else if (room.phase === 'panic') {
      p.score = 0;
      say(room, 'join', p.name, 'joined mid-round (0 points)');
      broadcast(room);
    } else if (room.phase === 'tanks') {
      p.score = 0;
      const t = room.tanks;
      if (!t.over && t.state === 'live' && t.units.size < TK2_SPAWNS.length) {
        const s = TK2_SPAWNS[t.units.size];
        t.units.set(p.id, {
          id: p.id, x: s.x, y: s.y, dir: s.dir,
          hp: TK2_HP, alive: true, lastFire: 0, want: null
        });
        t.points.set(p.id, 0);
        say(room, 'join', p.name, 'joined the round');
      }
      broadcast(room);
    } else {
      say(room, 'join', p.name, 'joined');
      broadcast(room);
    }
  }
  p.lastSeen = now();
  sendJSON(res, 200, { pid: p.id, secret: p.secret, state: view(room, p.id) });
}

function act(res, b) {
  const room = rooms.get(String(b.room || '').toUpperCase());
  const p = room && room.players.get(String(b.pid || ''));
  if (!room || !p || p.secret !== b.secret) {
    return sendJSON(res, 403, { e: 'Session expired. Rejoin.' });
  }
  p.lastSeen = now();
  const a = b.action;

  if (a === 'start') {
    if (room.hostId !== p.id) return sendJSON(res, 403, { e: 'Only the host starts the game.' });
    if (room.phase !== 'lobby') return sendJSON(res, 409, { e: 'A game is already running.' });
    if (room.order.filter((id) => room.players.has(id)).length < 2) return sendJSON(res, 409, { e: 'Two players minimum.' });
    if (room.game === 'stop') startStop(room);
    else if (room.game === 'panic') startPanic(room);
    else if (room.game === 'bonk') startBonk(room);
    else if (room.game === 'tanks') startTanks(room);
    else startBomb(room);
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'pick') {
    if (room.hostId !== p.id) return sendJSON(res, 403, { e: 'Host picks the game.' });
    if (room.phase !== 'lobby') return sendJSON(res, 409, { e: 'Not in the lobby.' });
    const g = String(b.game || '');
    room.game = g === 'stop' || g === 'panic' || g === 'bonk' || g === 'tanks' ? g : 'bomb';
    broadcast(room);
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'fire') {
    const err = tk2Shoot(room, p);
    if (err) return sendJSON(res, 409, { ok: false, e: err });
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'input') {
    if (room.phase !== 'bonk' || room.bonk.over) return sendJSON(res, 200, { ok: true });
    const body = room.bonk.bodies.get(p.id);
    if (!body || !body.alive) return sendJSON(res, 200, { ok: true });
    body.in.l = b.l ? 1 : 0;
    body.in.r = b.r ? 1 : 0;
    if (b.j) body.in.j = 1;
    return sendJSON(res, 200, { ok: true });
  }

  if (a === 'tap') {
    const err = panicTap(room, p, b.pick);
    if (err) return sendJSON(res, 409, { ok: false, e: err });
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'word') {
    if (room.phase !== 'bomb') return sendJSON(res, 409, { e: 'Bomb Word is not running.' });
    if (room.bomb.turnId !== p.id) return sendJSON(res, 409, { e: 'Not your turn.' });
    const err = checkWord(room, b.word);
    if (err) return sendJSON(res, 200, { ok: false, e: err });
    takeWord(room, p, b.word);
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'go') {
    const err = stopGo(room, p);
    if (err) return sendJSON(res, 409, { ok: false, e: err });
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'hit') {
    const st = room.stop;
    if (room.phase !== 'stop' || !st.running || st.runningPid !== p.id) {
      return sendJSON(res, 409, { ok: false, e: 'Nothing to stop.' });
    }
    stopRecord(room, p, now() - st.startedAt, false);
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'again') {
    if (room.hostId !== p.id) return sendJSON(res, 403, { e: 'Host only.' });
    room.phase = 'lobby';
    room.winnerId = null;
    room.overText = '';
    room.bomb.turnId = null;
    room.bomb.deadline = 0;
    room.stop.round = 0;
    room.stop.tries = [];
    room.stop.running = false;
    room.panic.round = 0;
    room.panic.solvedBy = null;
    room.panic.deadline = 0;
    room.panic.nextAt = 0;
    room.panic.locked = [];
    room.tanks.round = 0;
    room.tanks.state = 'idle';
    room.tanks.over = false;
    room.tanks.map = [];
    room.tanks.units = new Map();
    room.tanks.points = new Map();
    room.tanks.bullets = [];
    room.tanks.lastKill = null;
    room.tanks.endsAt = 0;
    room.tanks.nextAt = 0;
    for (const q of room.players.values()) { q.score = 0; q.lives = MAX_LIVES; }
    say(room, 'sys', null, 'Back in the lobby.');
    broadcast(room);
    return sendJSON(res, 200, { ok: true, state: view(room, p.id) });
  }

  if (a === 'leave') {
    room.players.delete(p.id);
    room.order = room.order.filter((x) => x !== p.id);
    room.stop.order = room.stop.order.filter((x) => x !== p.id);
    if (room.hostId === p.id) room.hostId = room.order[0] || null;
    if (room.players.size === 0) { rooms.delete(room.code); return sendJSON(res, 200, { ok: true }); }
    if (room.phase === 'bomb' && room.bomb.turnId === p.id) bombPass(room);
    if (room.phase === 'stop') {
      if (room.stop.runningPid === p.id) { room.stop.running = false; room.stop.runningPid = null; room.stop.idx += 1; }
      room.stop.base = room.stop.base.filter((x) => x !== p.id);
      if (room.stop.idx >= room.stop.order.length && room.stop.order.length) finishStopRound(room);
    }
    if (room.phase === 'bonk' && !room.bonk.over) {
      const body = room.bonk.bodies.get(p.id);
      if (body) body.alive = false;
      const left = [...room.bonk.bodies.values()].filter((x) => x.alive).length;
      if (left <= 1) bonkEndRound(room);
    }
    if (room.phase === 'tanks' && !room.tanks.over) {
      room.tanks.units.delete(p.id);
      room.tanks.points.delete(p.id);
      room.tanks.order = room.tanks.order.filter((x) => x !== p.id);
      room.tanks.bullets = room.tanks.bullets.filter((b) => b.owner !== p.id);
      if (room.tanks.state === 'live') tk2Resolve(room);
    }
    broadcast(room);
    return sendJSON(res, 200, { ok: true });
  }

  sendJSON(res, 400, { e: 'Unknown action.' });
}

function events(req, res, url) {
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const pid = url.searchParams.get('pid');
  const p = room && room.players.get(String(pid || ''));
  if (!room || !p || p.secret !== url.searchParams.get('secret')) {
    return sendJSON(res, 403, { e: 'Session expired.' });
  }
  p.lastSeen = now();
  if (room.v > Number(url.searchParams.get('since') || 0)) {
    return sendJSON(res, 200, view(room, pid));
  }
  const w = { pid, res, timer: null };
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(w.timer);
    room.waiters = room.waiters.filter((x) => x !== w);
    p.live = Math.max(0, p.live - 1);
    p.lastSeen = now();
  };
  p.live++;
  w.timer = setTimeout(() => {
    finish();
    if (!res.writableEnded) sendJSON(res, 200, { t: 'noop', v: room.v });
  }, 20000);
  room.waiters.push(w);
  res.on('close', finish);
}

const ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'qr.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8'
};

async function serveStatic(res, pathname) {
  let name = pathname.split('/').pop() || 'index.html';
  if (!name) name = 'index.html';
  const type = ASSETS[name];
  if (!type) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
  try {
    const buf = await readFile(join(ROOT, name));
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(buf);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('missing ' + name);
  }
}

function safeUrl(raw, base) {
  try { return new URL(raw || '/', base); } catch { return new URL('/', base); }
}

const server = createServer(async (req, res) => {
  let url, path;
  try {
    url = safeUrl(req.url, 'http://localhost');
    path = url.pathname || '/';
  } catch {
    return sendJSON(res, 400, { e: 'bad request' });
  }
  try {
    if (path.endsWith('/health')) return sendJSON(res, 200, { ok: true, rooms: rooms.size });
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (path.endsWith('/api/hello')) return hello(res, body);
      if (path.endsWith('/api/act')) return act(res, body);
      return sendJSON(res, 404, { e: 'no route' });
    }
    if (path.endsWith('/api/events')) return events(req, res, url);
    return await serveStatic(res, path);
  } catch (err) {
    console.error('route error:', err && err.stack ? err.stack : err);
    if (!res.writableEnded) sendJSON(res, 500, { e: 'server error' });
  }
});

/* ------------------------- websocket, hand-rolled ------------------------- */

function wsFrame(str, op = 0x1) {
  const buf = Buffer.from(str);
  const len = buf.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | op;
  return Buffer.concat([head, buf]);
}

function wsText(sock, str) {
  if (!sock || sock.destroyed) return;
  try { sock.write(wsFrame(str)); } catch { /* socket gone */ }
}

server.on('upgrade', (req, socket) => {
  socket.on('error', () => socket.destroy());
  const key = req.headers['sec-websocket-key'];
  if (!key) return socket.destroy();
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  socket.setTimeout(0);

  let url;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    try { socket.destroy(); } catch { /* ignore */ }
    return;
  }
  const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
  const p = room && room.players.get(String(url.searchParams.get('pid') || ''));
  if (!p || p.secret !== url.searchParams.get('secret')) {
    try { socket.end(wsFrame(JSON.stringify({ t: 'bye' }))); } catch { /* ignore */ }
    return;
  }

  p.ws = socket;
  p.live++;
  p.lastSeen = now();
  wsText(socket, JSON.stringify(view(room, p.id)));

  const ka = setInterval(() => {
    if (socket.destroyed) return clearInterval(ka);
    try { socket.write(wsFrame('', 0x9)); } catch { clearInterval(ka); }
  }, 25000);

  const roomRef = room;
  const pidRef = p.id;
  let buf = Buffer.alloc(0);
  let frag = '';

  const onInput = (msg) => {
    if (roomRef.phase === 'tanks' && !roomRef.tanks.over) {
      const t = roomRef.tanks;
      if (t.state !== 'live') return;
      const u = t.units.get(pidRef);
      if (!u || !u.alive) return;
      if (typeof msg.d === 'number' && Number.isFinite(msg.d)) {
        u.want = ((Math.round(msg.d) % 4) + 4) % 4;
      } else if (msg.d === null) {
        u.want = null;
      }
      if (msg.fire) tk2Shoot(roomRef, roomRef.players.get(pidRef));
      return;
    }
    if (roomRef.phase !== 'bonk' || roomRef.bonk.over) return;
    const body = roomRef.bonk.bodies.get(pidRef);
    if (!body || !body.alive) return;
    body.in.l = msg.l ? 1 : 0;
    body.in.r = msg.r ? 1 : 0;
    if (msg.j) body.in.j = 1;
  };

  const done = () => {
    clearInterval(ka);
    if (p.ws === socket) p.ws = null;
    p.live = Math.max(0, p.live - 1);
    p.lastSeen = now();
  };

  socket.on('close', done);
  socket.on('end', done);
  socket.on('error', done);

  const parse = () => {
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0], b1 = buf[1];
      const op = b0 & 0x0f;
      const fin = (b0 & 0x80) !== 0;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f, off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2)); off = 10;
      }
      if (len > 65536) { try { socket.destroy(); } catch { /* ignore */ } return; }
      const mOff = off;
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let payload = buf.subarray(off, off + len);
      if (masked) {
        const m = buf.subarray(mOff, mOff + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
        payload = out;
      }
      buf = buf.subarray(off + len);
      if (op === 0x8) { try { socket.end(wsFrame('', 0x8)); } catch { /* ignore */ } return done(); }
      if (op === 0x9) { try { socket.write(wsFrame(payload.toString(), 0xA)); } catch { /* ignore */ } continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x0) {
        frag += payload.toString('utf8');
        if (fin) {
          const raw = frag;
          frag = '';
          try {
            const msg = JSON.parse(raw);
            if (msg && msg.t === 'in') onInput(msg);
          } catch { /* garbage, ignored */ }
        }
      }
    }
  };

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    if (buf.length > 131072) { try { socket.destroy(); } catch { /* ignore */ } return; }
    parse();
  });
});

/* ------------------------------ loops ------------------------------ */

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'bomb') {
      const b = room.bomb;
      const holder = room.players.get(b.turnId);
      if (!holder) {
        const next = nextAwake(room, b.turnId, aliveList(room));
        if (!next) { room.phase = 'over'; room.winnerId = null; room.overText = 'Everyone left.'; broadcast(room); continue; }
        b.turnId = next;
        b.deadline = now() + b.timeMs;
        broadcast(room);
        continue;
      }
      if (!awake(holder)) {
        const next = nextAwake(room, b.turnId, aliveList(room));
        if (!next) { b.deadline = now() + b.timeMs; continue; }
        say(room, 'sys', null, holder.name + ' vanished. Bomb moves on.');
        b.turnId = next;
        b.deadline = now() + b.timeMs;
        broadcast(room);
        continue;
      }
      if (b.deadline && now() > b.deadline + 350) explode(room);
      continue;
    }

    if (room.phase === 'stop') {
      const st = room.stop;
      if (st.idx >= st.order.length && st.order.length) { finishStopRound(room); continue; }

      if (st.running) {
        const runner = room.players.get(st.runningPid);
        if (runner && awake(runner)) {
          if (now() - st.startedAt > HOLD_CAP) stopRecord(room, runner, now() - st.startedAt, true);
        } else if (runner) {
          say(room, 'sys', null, runner.name + ' went quiet. Shot counted as ' + (HOLD_CAP / 1000) + 's.');
          stopRecord(room, runner, HOLD_CAP, true);
        }
        continue;
      }

      const who = room.players.get(st.order[st.idx]);
      if (!who) { st.idx += 1; continue; }
      if (now() > st.turnDeadline) {
        say(room, 'sys', null, who.name + ' froze. Shot counted as ' + (GO_GRACE / 1000) + 's.');
        stopRecord(room, who, GO_GRACE, true);
      }
      continue;
    }

    if (room.phase === 'panic') {
      const pn = room.panic;
      if (pn.deadline && now() > pn.deadline) { finishPanicRound(room); continue; }
      if (!pn.deadline && pn.nextAt && now() > pn.nextAt) { newPanicRound(room); continue; }
    }

    if (room.phase === 'bonk') bonkTick(room);

  }
}, 250);

/* bonk physics gets its own 33 ms beat; the 250 ms loop above is for the
   slow games and must not be relied on for anything kinematic. */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'bonk') bonkTick(room);
  }
}, 33);

/* tank shells need a fine beat: the trajectory is integrated against it */
setInterval(() => {
  for (const room of rooms.values()) {
    if (room.phase === 'tanks') tk2Tick(room);
  }
}, 33);

setInterval(() => {
  for (const [code, room] of rooms) {
    if (now() - room.touched > 3 * 3600 * 1000) { rooms.delete(code); continue; }
    if (room.phase !== 'lobby') continue;
    for (const [id, p] of room.players) {
      if (p.live <= 0 && now() - p.lastSeen > 120000) {
        room.players.delete(id);
        room.order = room.order.filter((x) => x !== id);
        if (room.hostId === id) room.hostId = room.order[0] || null;
      }
    }
    if (room.players.size === 0 && now() - room.touched > 60000) rooms.delete(code);
  }
}, 20000);

process.on('uncaughtException', (err) => {
  console.error('uncaught:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandled:', err && err.stack ? err.stack : err);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('PARTY SUITE on :' + PORT);
});
