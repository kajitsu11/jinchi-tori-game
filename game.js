'use strict';
(() => {
// ===== 定数 =====
let W = 160, H = 100, N = W * H;     // マップのマス数（縦長画面では縦長マップ）
const C = 6;                          // オフスクリーン描画での1マスのピクセル数
const TICK_MS = 100;
const SAM_RANGE = 20;
const WIN_SHARE = 0.8;

const BUILD = {
  city: { name: '都市',        icon: '🏙', base: 2000, scale: 1.0, key: '1' },
  silo: { name: 'ミサイル基地', icon: '🚀', base: 4000, scale: 1.0, key: '2' },
  sam:  { name: '迎撃基地',    icon: '🛡', base: 3500, scale: 0.6, key: '3' },
};
const NUKE = {
  atom:  { name: '原子爆弾', icon: '☢', cost: 6000,  r: 5,  key: '4' },
  hydro: { name: '水素爆弾', icon: '💥', cost: 20000, r: 12, key: '5' },
  mirv:  { name: 'MIRV',    icon: '🎆', cost: 50000, r: 4,  key: '6', warheads: 14 },
};
const WARHEAD_R = 4;

const DIFF = {
  easy:   { label: 'かんたん',  growth: 0.8,  brave: 0.6, hateMe: 0.1,  nukeStart: 1500, nukeRate: 0.04 },
  normal: { label: 'ふつう',    growth: 1.0,  brave: 0.9, hateMe: 0.25, nukeStart: 1000, nukeRate: 0.08 },
  hard:   { label: 'むずかしい', growth: 1.15, brave: 1.2, hateMe: 0.45, nukeStart: 600,  nukeRate: 0.13 },
};

const ME_COLOR = '#8a6cf0';
const PALETTE = ['#f6d55c', '#ef8fd6', '#6cc36a', '#f39a5b', '#4f8fe0', '#e86a6a', '#42c2b0', '#b48a5e',
  '#c39af0', '#9bd14b', '#ff7fa8', '#8c9db5', '#e0b03a', '#5ca86c'];
const BOT_NAMES = ['ねこ県', 'いぬ市', 'たぬき町', 'きつね村', 'うさぎ王国', 'くま共和国', 'ぺんぎん連邦',
  'かっぱ国', 'からす藩', 'さる県', 'しか市', 'ぶた町', 'かめ公国', 'たこ帝国'];

// ===== 状態 =====
let terrain, elev, owner, fallout, baseRGB;
let players, bAt, attacks, missiles, effects, logs;
let state = 'menu', tick = 0, landCount = 0, speed = 1, paused = false, diff = DIFF.normal;
let me = 0, mode = null, hoverTile = -1, shake = 0, mapDirty = true, tileHistory = [];
const cam = { x: 0, y: 0, s: 6 };

const $ = (id) => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');
let img, pix;
function setDims() {
  const portrait = window.innerHeight > window.innerWidth * 1.1;
  [W, H] = portrait ? [104, 150] : [160, 100];
  N = W * H;
  off.width = W * C; off.height = H * C;
  img = octx.createImageData(W * C, H * C);
  pix = img.data;
}

// ===== ユーティリティ =====
function mulberry32(a) {
  return () => {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hex2rgb(h) { const n = parseInt(h.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; }
function fmt(n) {
  n = Math.max(0, n);
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toString();
}
function reservoir(arr, n, v, k) {
  if (n < k) arr.push(v);
  else { const j = Math.floor(Math.random() * (n + 1)); if (j < k) arr[j] = v; }
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function timeStr(t) { const s = Math.floor(t / 10); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); }

// ===== マップ生成 =====
function genMap(seed) {
  const r = mulberry32(seed);
  const makeNoise = (cell) => {
    const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let k = 0; k < g.length; k++) g[k] = r();
    return (x, y) => {
      const fx = x / cell, fy = y / cell, ix = fx | 0, iy = fy | 0;
      const tx = fx - ix, ty = fy - iy;
      const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
      const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const oct = [[28, 1], [14, 0.5], [7, 0.25], [3.5, 0.12]].map(([c, w]) => [makeNoise(c), w]);
  const h = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (const [f, w] of oct) v += f(x, y) * w;
    v /= 1.87;
    const dx = (x / W - 0.5) * 2, dy = (y / H - 0.5) * 2;
    v -= (dx * dx + dy * dy) * 0.32;
    h[y * W + x] = v;
  }
  const sorted = Array.from(h).sort((a, b) => a - b);
  const thr = sorted[Math.floor(N * 0.42)], top = sorted[N - 1];
  terrain = new Uint8Array(N);
  for (let i = 0; i < N; i++) terrain[i] = h[i] > thr ? 1 : 0;

  // 最大の大陸だけを残す（船がないので）
  const comp = new Int32Array(N).fill(-1);
  let best = -1, bestSize = 0, cid = 0;
  for (let i = 0; i < N; i++) {
    if (!terrain[i] || comp[i] >= 0) continue;
    const stack = [i]; comp[i] = cid; let size = 0;
    while (stack.length) {
      const j = stack.pop(); size++;
      for (const k of neighbors(j)) if (terrain[k] && comp[k] < 0) { comp[k] = cid; stack.push(k); }
    }
    if (size > bestSize) { bestSize = size; best = cid; }
    cid++;
  }
  landCount = 0;
  elev = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (terrain[i] && comp[i] !== best) terrain[i] = 0;
    if (terrain[i]) { landCount++; elev[i] = (h[i] - thr) / (top - thr); }
    else elev[i] = Math.min(1, (thr - h[i]) / 0.25);
  }

  baseRGB = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    let c;
    if (!terrain[i]) {
      const d = elev[i];
      c = [158 - d * 50, 214 - d * 50, 242 - d * 25];
    } else if (elev[i] > 0.62) {
      c = [226, 214, 186];   // 山地
    } else {
      const e = elev[i];
      c = [246 - e * 12, 240 - e * 10, 222 - e * 18];
    }
    baseRGB.set(c.map(Math.round), i * 3);
  }
}
function neighbors(i) {
  const x = i % W, out = [];
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  if (i >= W) out.push(i - W);
  if (i < N - W) out.push(i + W);
  return out;
}

// ===== プレイヤー =====
function makePlayer(id, name, color, isBot) {
  return {
    id, name, color, rgb: hex2rgb(color), isBot, alive: true,
    troops: 2500, gold: 500, tiles: 0, cnt: { city: 0, silo: 0, sam: 0 },
    nb: new Set(), samples: [], interior: [], lx: 0, ly: 0,
    ai: { next: 20 + Math.floor(Math.random() * 20), grudge: -1, thr: 0.35 + Math.random() * 0.25 },
  };
}
const maxTroops = (p) => 1000 + p.tiles * 25 + p.cnt.city * 5000;
const goldRate = (p) => 1 + p.tiles * 0.03 + p.cnt.city * 2;
const buildCost = (p, type) => Math.round(BUILD[type].base * (1 + BUILD[type].scale * p.cnt[type]));

function setOwner(i, o) {
  const old = owner[i];
  if (old === o) return;
  if (old >= 0) players[old].tiles--;
  owner[i] = o;
  if (o >= 0) players[o].tiles++;
  const b = bAt.get(i);
  if (b) {
    if (old >= 0) players[old].cnt[b.type]--;
    if (o >= 0) { b.owner = o; players[o].cnt[b.type]++; }   // 建物は占領される
    else bAt.delete(i);
  }
  mapDirty = true;
}

// ===== ゲーム開始 =====
function newGame() {
  const nBots = parseInt($('optBots').value, 10);
  diff = DIFF[$('optDiff').value];
  setDims();
  genMap((Math.random() * 1e9) | 0);
  owner = new Int16Array(N).fill(-1);
  fallout = new Float32Array(N);
  bAt = new Map(); attacks = []; missiles = []; effects = []; logs = []; tileHistory = [];
  players = [makePlayer(0, $('optName').value.trim() || 'あなたの国', ME_COLOR, false)];
  const names = shuffle(BOT_NAMES.slice()), cols = shuffle(PALETTE.slice());
  for (let k = 0; k < nBots; k++) players.push(makePlayer(k + 1, names[k], cols[k], true));
  me = 0; tick = 0; mode = null; paused = false; speed = 1;
  state = 'spawn';
  mapDirty = true;
  $('overlay').classList.add('hidden');
  $('endCard').classList.add('hidden');
  ['infoCard', 'sideBtns', 'bottom'].forEach((id) => $(id).classList.remove('hidden'));
  closeSheet();
  fitCamera();
  setHint('🏁 スタート地点をタップしてね');
  ticker('スタート地点を選んでください', null);
  buildButtons();
  updateUI(true);
}

function claimSpawn(p, i) {
  const x0 = i % W, y0 = (i / W) | 0, R = 3;
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= W || y >= H || dx * dx + dy * dy > R * R + 1) continue;
    const j = y * W + x;
    if (terrain[j] && owner[j] < 0) setOwner(j, p.id);
  }
}

function startGame(spawnTile) {
  claimSpawn(players[me], spawnTile);
  const spawns = [spawnTile];
  for (const p of players) {
    if (p.id === me) continue;
    let minD = 30, placed = false;
    for (let tries = 0; tries < 4000 && !placed; tries++) {
      if (tries % 400 === 399) minD *= 0.8;
      const i = Math.floor(Math.random() * N);
      if (!terrain[i] || owner[i] >= 0) continue;
      const x = i % W, y = (i / W) | 0;
      if (spawns.every((s) => Math.hypot(s % W - x, ((s / W) | 0) - y) >= minD)) {
        claimSpawn(p, i); spawns.push(i); placed = true;
      }
    }
    if (!placed) p.alive = false;
  }
  scan();
  state = 'play';
  setHint(null);
  log(`${players[me].name} が建国されました！`, me);
}

// ===== 攻撃 =====
function launchAttack(a, t, troops) {
  for (const at of attacks) {
    if (at.a === t && at.t === a && troops > 0) {   // 正面衝突は相殺
      const m = Math.min(at.troops, troops);
      at.troops -= m; troops -= m;
    }
  }
  if (troops < 1) return;
  const ex = attacks.find((x) => x.a === a && x.t === t);
  if (ex) ex.troops += troops;
  else attacks.push({ a, t, troops });
  if (t === me && a !== me && Math.random() < 0.5) log(`${players[a].name} があなたに攻撃してきた！`, a, 'warn');
}

function tileCost(i, t) {
  let c;
  if (t < 0) c = 8;
  else { const D = players[t]; c = 10 + 1.5 * D.troops / Math.max(1, D.tiles); }
  if (elev[i] > 0.62) c *= 1.8;
  return c * (1 + fallout[i] * 3);
}

function processAttacks() {
  for (const at of attacks) {
    const A = players[at.a];
    if (!A.alive) { at.troops = 0; continue; }
    const cand = [];
    for (let i = 0; i < N; i++) {
      if (owner[i] !== at.t || !terrain[i]) continue;
      const x = i % W;
      let c = 0;
      if (x > 0 && owner[i - 1] === at.a) c++;
      if (x < W - 1 && owner[i + 1] === at.a) c++;
      if (i >= W && owner[i - W] === at.a) c++;
      if (i < N - W && owner[i + W] === at.a) c++;
      if (c) cand.push({ i, s: c + Math.random() * 1.5 });
    }
    if (!cand.length) { A.troops += at.troops; at.troops = 0; continue; }
    cand.sort((p, q) => q.s - p.s);
    const n = Math.min(cand.length, 1 + Math.floor(cand.length * (at.t < 0 ? 0.03 : 0.02)));
    const D = at.t >= 0 ? players[at.t] : null;
    for (let k = 0; k < n; k++) {
      const i = cand[k].i, cost = tileCost(i, at.t);
      if (at.troops < cost) { A.troops += at.troops; at.troops = 0; break; }
      at.troops -= cost;
      if (D) D.troops = Math.max(0, D.troops - (D.troops / Math.max(1, D.tiles)) * 0.5);
      setOwner(i, at.a);
    }
  }
  attacks = attacks.filter((at) => at.troops >= 1);
}

// ===== 建設 =====
function canPlace(p, i) {
  if (owner[i] !== p.id || bAt.has(i)) return false;
  for (const b of bAt.values()) if (Math.abs(b.x - i % W) <= 2 && Math.abs(b.y - ((i / W) | 0)) <= 2) return false;
  return true;
}
function placeBuilding(p, type, i) {
  const cost = buildCost(p, type);
  if (p.gold < cost) return '金が足りません';
  if (!canPlace(p, i)) return owner[i] !== p.id ? '自分の領土に建ててください' : '近くに建物があります';
  p.gold -= cost;
  bAt.set(i, { type, i, x: i % W, y: (i / W) | 0, owner: p.id, cd: 0 });
  p.cnt[type]++;
  mapDirty = true;
  return null;
}

// ===== 核 =====
function readySilo(p, tx, ty) {
  let best = null, bd = Infinity;
  for (const b of bAt.values()) {
    if (b.owner !== p.id || b.type !== 'silo' || b.cd > 0) continue;
    const d = Math.hypot(b.x - tx, b.y - ty);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
function launchNuke(p, type, ti) {
  const N_ = NUKE[type];
  if (p.gold < N_.cost) return '金が足りません';
  if (!p.cnt.silo) return 'ミサイル基地がありません';
  const tx = ti % W, ty = (ti / W) | 0;
  const silo = readySilo(p, tx, ty);
  if (!silo) return 'ミサイル基地が再装填中です';
  p.gold -= N_.cost;
  silo.cd = 50;
  const dist = Math.hypot(tx - silo.x, ty - silo.y);
  const victim = terrain[ti] ? owner[ti] : -1;
  const m = { type, owner: p.id, sx: silo.x, sy: silo.y, tx, ty, t: 0, dur: 25 + dist * 0.5, victim, intercept: -1, born: performance.now() };
  if (type !== 'mirv') {
    for (const b of bAt.values()) {
      if (b.type !== 'sam' || b.owner === p.id || b.cd > 0) continue;
      if (Math.hypot(b.x - tx, b.y - ty) <= SAM_RANGE) {
        m.intercept = 0.82; m.samX = b.x; m.samY = b.y; m.samOwner = b.owner; b.cd = 80;
        break;
      }
    }
  }
  missiles.push(m);
  if (victim >= 0 && players[victim].isBot) players[victim].ai.grudge = p.id;
  if (victim === me) log(`☢ ${p.name} があなたに${N_.name}を発射！`, p.id, 'warn');
  else if (p.id === me) log(`${N_.name}を発射！`, me);
  else log(`${p.name} が${victim >= 0 ? players[victim].name + 'に' : ''}${N_.name}を発射`, p.id);
  return null;
}

function updateMissiles() {
  const spawned = [];
  for (const m of missiles) {
    m.t++;
    const f = m.t / m.dur;
    if (m.intercept > 0 && f >= m.intercept) {
      m.dead = true;
      const pos = missilePos(m, f);
      effects.push({ kind: 'pop', x: pos.x, y: pos.y, start: performance.now(), dur: 700 });
      if (m.samOwner === me) log(`🛡 迎撃成功！${players[m.owner].name}の${NUKE[m.type].name}を撃墜`, me, 'good');
      else if (m.owner === me) log(`${players[m.samOwner].name}に迎撃された…`, m.samOwner);
      continue;
    }
    if (f < 1) continue;
    m.dead = true;
    if (m.type === 'mirv') spawned.push(...splitMirv(m));
    else detonate(m.tx, m.ty, m.type === 'warhead' ? WARHEAD_R : NUKE[m.type].r, m.owner);
  }
  missiles = missiles.filter((m) => !m.dead).concat(spawned);
}
function splitMirv(m) {
  const targets = [];
  if (m.victim >= 0 && players[m.victim].tiles > 0) {
    const all = [];
    for (let i = 0; i < N; i++) if (owner[i] === m.victim) all.push(i);
    shuffle(all);
    targets.push(...all.slice(0, NUKE.mirv.warheads));
  }
  while (targets.length < NUKE.mirv.warheads) {
    const x = Math.round(m.tx + (Math.random() - 0.5) * 30), y = Math.round(m.ty + (Math.random() - 0.5) * 30);
    if (x >= 0 && y >= 0 && x < W && y < H) targets.push(y * W + x);
  }
  return targets.map((ti) => {
    const tx = ti % W, ty = (ti / W) | 0;
    return { type: 'warhead', owner: m.owner, sx: m.tx, sy: m.ty, tx, ty, t: 0, dur: 12 + Math.hypot(tx - m.tx, ty - m.ty) * 0.3, intercept: -1 };
  });
}
function detonate(x0, y0, r, by) {
  const lost = new Map();
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
    const x = x0 + dx, y = y0 + dy, d = Math.hypot(dx, dy);
    if (x < 0 || y < 0 || x >= W || y >= H || d > r) continue;
    const i = y * W + x, f = d / r;
    fallout[i] = Math.min(1, fallout[i] + 1 - f * 0.6);
    if (terrain[i] && owner[i] >= 0 && (f < 0.65 || Math.random() < 0.5)) {
      const o = owner[i];
      lost.set(o, (lost.get(o) || 0) + 1);
      setOwner(i, -1);
    } else if (f < 0.8 && bAt.has(i)) {
      const b = bAt.get(i);
      players[b.owner].cnt[b.type]--;
      bAt.delete(i);
    }
  }
  for (const [o, L] of lost) {
    const P = players[o], T = P.tiles + L;
    P.troops *= Math.max(0, 1 - (L / T) * 1.5 - 0.05);
    if (P.isBot && o !== by) P.ai.grudge = by;
  }
  effects.push({ kind: 'boom', x: x0, y: y0, r, start: performance.now(), dur: 1600 });
  shake = Math.min(18, shake + r * 1.2);
  mapDirty = true;
}
function missilePos(m, f) {
  const dist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
  return {
    x: m.sx + (m.tx - m.sx) * f,
    y: m.sy + (m.ty - m.sy) * f - Math.sin(Math.PI * f) * Math.min(30, dist * 0.3),
  };
}

// ===== 定期スキャン（隣接関係・サンプル・ラベル位置・勝敗） =====
function scan() {
  const sums = players.map(() => [0, 0]);
  for (const p of players) { p.nb = new Set(); p.samples = []; p.interior = []; p._sc = 0; p._ic = 0; }
  for (let i = 0; i < N; i++) {
    const o = owner[i];
    if (o < 0) continue;
    const P = players[o], x = i % W, y = (i / W) | 0;
    sums[o][0] += x; sums[o][1] += y;
    let inner = x > 0 && x < W - 1 && y > 0 && y < H - 1;
    for (const j of neighbors(i)) {
      if (!terrain[j]) { inner = false; continue; }
      if (owner[j] !== o) { P.nb.add(owner[j]); inner = false; }
    }
    reservoir(P.samples, P._sc++, i, 40);
    if (inner) reservoir(P.interior, P._ic++, i, 40);
  }
  for (const p of players) {
    if (!p.tiles) continue;
    const cx = sums[p.id][0] / p.tiles, cy = sums[p.id][1] / p.tiles;
    // 重心に一番近い内側のマスにラベルを置く（凹んだ形でも領土内に表示される）
    let best = null, bd = Infinity;
    for (const i of (p.interior.length ? p.interior : p.samples)) {
      const d = Math.hypot(i % W - cx, ((i / W) | 0) - cy);
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 3 || p.lx === 0) { p.lx = best % W + 0.5; p.ly = ((best / W) | 0) + 0.5; }
  }
  for (const p of players) {
    if (p.alive && p.tiles === 0 && state === 'play') {
      p.alive = false;
      attacks = attacks.filter((at) => at.a !== p.id);
      log(p.id === me ? 'あなたの国は滅亡しました…' : `${p.name} が滅亡した！`, p.id, p.id === me ? 'warn' : '');
    }
  }
  checkEnd();
}

function checkEnd() {
  if (state !== 'play') return;
  const P = players[me];
  const bots = players.filter((p) => p.isBot && p.alive);
  const leader = players.reduce((a, b) => (b.tiles > a.tiles ? b : a));
  if (!P.alive) endGame(false, 'あなたの国は滅ぼされてしまった…');
  else if (P.tiles >= landCount * WIN_SHARE) endGame(true, `全陸地の${Math.round(P.tiles / landCount * 100)}%を支配しました！`);
  else if (!bots.length) endGame(true, 'すべての敵国を滅ぼしました！');
  else if (leader.id !== me && leader.tiles >= landCount * WIN_SHARE) endGame(false, `${leader.name}が世界を支配してしまった…`);
}
function endGame(win, text) {
  state = win ? 'won' : 'lost';
  $('endTitle').textContent = win ? '🎉 勝利！' : '💀 敗北…';
  $('endText').textContent = `${text}（プレイ時間 ${timeStr(tick)}）`;
  $('menu').classList.add('hidden');
  $('endCard').classList.remove('hidden');
  $('overlay').classList.remove('hidden');
}

// ===== AI =====
function botThink(p) {
  p.ai.next = tick + 6 + Math.floor(Math.random() * 12);
  const mx = maxTroops(p);
  if (p.troops / mx > p.ai.thr) {
    const enemies = [...p.nb].filter((o) => o >= 0 && players[o].alive);
    const hasNeutral = p.nb.has(-1);
    let target = null;
    if (p.ai.grudge >= 0 && enemies.includes(p.ai.grudge) && Math.random() < 0.6) target = p.ai.grudge;
    else if (hasNeutral && (!enemies.length || Math.random() < Math.max(0.3, 0.85 - tick / 5000))) target = -1;
    else if (enemies.length) {
      if (enemies.includes(me) && Math.random() < diff.hateMe) target = me;
      else {
        enemies.sort((a, b) => players[a].troops - players[b].troops);
        const e = enemies[0];
        if (players[e].troops < p.troops * diff.brave || Math.random() < 0.12) target = e;
      }
    }
    const busy = target === -1 && attacks.some((at) => at.a === p.id && at.t === -1 && at.troops > 100);
    if (target !== null && !busy) {
      const send = p.troops * (0.2 + Math.random() * 0.3) * (target >= 0 ? 1.4 : 1);
      p.troops -= send;
      launchAttack(p.id, target, send);
    }
  }
  if (Math.random() < 0.5) botBuild(p);
  if (p.cnt.silo && tick > diff.nukeStart && Math.random() < diff.nukeRate) botNuke(p);
}
function botBuild(p) {
  let type = 'city';
  if (tick > diff.nukeStart * 0.6 && p.tiles > 100 && p.cnt.silo < 1 + Math.floor(p.tiles / 600)) type = 'silo';
  else if (p.cnt.silo && p.cnt.sam < p.cnt.silo + Math.floor(p.tiles / 400)) type = 'sam';
  else if (p.cnt.city >= 1 + p.tiles / 120) return;
  const reserve = p.cnt.silo && type === 'city' ? NUKE.atom.cost : 0;
  if (p.gold < buildCost(p, type) + reserve) return;
  for (const i of shuffle(p.interior.slice())) if (canPlace(p, i)) { placeBuilding(p, type, i); return; }
}
function botNuke(p) {
  let type = null;
  if (p.gold >= NUKE.mirv.cost && Math.random() < 0.3) type = 'mirv';
  else if (p.gold >= NUKE.hydro.cost && Math.random() < 0.6) type = 'hydro';
  else if (p.gold >= NUKE.atom.cost) type = 'atom';
  if (!type) return;
  const others = players.filter((q) => q.alive && q.id !== p.id && q.tiles > 0);
  if (!others.length) return;
  let t = p.ai.grudge >= 0 && players[p.ai.grudge].alive ? players[p.ai.grudge] : null;
  if (!t) {
    if (players[me].alive && Math.random() < diff.hateMe) t = players[me];
    else t = others.reduce((a, b) => (b.tiles > a.tiles ? b : a));
  }
  const cities = [...bAt.values()].filter((b) => b.owner === t.id);
  let ti;
  if (cities.length && Math.random() < 0.5) ti = cities[Math.floor(Math.random() * cities.length)].i;
  else {
    const pool = t.interior.length ? t.interior : t.samples;
    if (!pool.length) return;
    ti = pool[Math.floor(Math.random() * pool.length)];
  }
  launchNuke(p, type, ti);
}

// ===== メインループ =====
function step() {
  tick++;
  for (const p of players) {
    if (!p.alive) continue;
    const mx = maxTroops(p), g = p.isBot ? diff.growth : 1;
    if (p.troops < mx) p.troops = Math.min(mx, p.troops + (1 + mx * 0.0025 * (1 - p.troops / mx)) * g);
    else p.troops -= (p.troops - mx) * 0.02;
    p.gold += goldRate(p) * g;
  }
  processAttacks();
  for (const b of bAt.values()) if (b.cd > 0) b.cd--;
  updateMissiles();
  if (tick % 10 === 0) {
    for (let i = 0; i < N; i++) if (fallout[i] > 0) { fallout[i] = Math.max(0, fallout[i] - 0.006); mapDirty = true; }
    tileHistory.push(players[me].tiles);
    if (tileHistory.length > 11) tileHistory.shift();
  }
  if (tick % 5 === 0) scan();
  if (state === 'play' || state === 'watch') {
    for (const p of players) if (p.isBot && p.alive && tick >= p.ai.next) botThink(p);
  }
}

let last = performance.now(), acc = 0, uiTimer = 0;
function frame(now) {
  const dt = Math.min(250, now - last);
  last = now;
  if ((state === 'play' || state === 'watch') && !paused) {
    acc += dt * speed;
    while (acc >= TICK_MS) { acc -= TICK_MS; step(); }
  }
  if (players) render(now);
  uiTimer += dt;
  if (uiTimer > 150 && players) { uiTimer = 0; updateUI(); }
  requestAnimationFrame(frame);
}

// ===== 描画 =====
function mix(a, b, t) { return a + (b - a) * t; }
function renderMap() {
  const hov = mode === null && hoverTile >= 0 && terrain[hoverTile] ? owner[hoverTile] : -2;
  const rowW = W * C;
  for (let i = 0; i < N; i++) {
    const cx = (i % W) * C, cy = ((i / W) | 0) * C, o = owner[i];
    let r = baseRGB[i * 3], g = baseRGB[i * 3 + 1], b = baseRGB[i * 3 + 2];
    let striped = false;
    if (o >= 0) {
      const c = players[o].rgb;
      r = c[0]; g = c[1]; b = c[2];
      striped = true;
      if (o === hov && o !== me) { r = mix(r, 255, 0.25); g = mix(g, 255, 0.25); b = mix(b, 255, 0.25); }
    }
    const fo = fallout[i];
    if (fo > 0) { const f = fo * 0.65; r = mix(r, 150, f); g = mix(g, 220, f); b = mix(b, 40, f); }
    const water = !terrain[i];
    for (let py = 0; py < C; py++) {
      let p = ((cy + py) * rowW + cx) * 4;
      for (let px = 0; px < C; px++, p += 4) {
        let R = r, G = g, B = b;
        if (px === C - 1 || py === C - 1) {          // マス目の線
          const k = water ? 0.94 : 0.86;
          R *= k; G *= k; B *= k;
        } else if (striped && (px + (C - py)) % 4 === 0) {   // 斜線模様
          R = mix(R, 255, 0.22); G = mix(G, 255, 0.22); B = mix(B, 255, 0.22);
        }
        pix[p] = R; pix[p + 1] = G; pix[p + 2] = B; pix[p + 3] = 255;
      }
    }
  }
  octx.putImageData(img, 0, 0);
  mapDirty = false;
}

function strokeOutline(pid, color, width) {
  ctx.beginPath();
  const s = cam.s;
  for (let i = 0; i < N; i++) {
    if (owner[i] !== pid) continue;
    const x = i % W, y = (i / W) | 0, X = cam.x + x * s, Y = cam.y + y * s;
    if (x === 0 || owner[i - 1] !== pid) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + s); }
    if (x === W - 1 || owner[i + 1] !== pid) { ctx.moveTo(X + s, Y); ctx.lineTo(X + s, Y + s); }
    if (y === 0 || owner[i - W] !== pid) { ctx.moveTo(X, Y); ctx.lineTo(X + s, Y); }
    if (y === H - 1 || owner[i + W] !== pid) { ctx.moveTo(X, Y + s); ctx.lineTo(X + s, Y + s); }
  }
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.stroke();
}

function pillLabel(text, x, y, size, bg, fg) {
  ctx.font = `800 ${size}px "M PLUS Rounded 1c", sans-serif`;
  const w = ctx.measureText(text).width + size * 0.9, h = size * 1.45;
  ctx.fillStyle = bg; ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(1.5, size * 0.12);
  ctx.beginPath(); ctx.roundRect(x - w / 2, y - h / 2, w, h, h / 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = fg; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, x, y + size * 0.05);
}

function render(now) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (mapDirty) renderMap();
  ctx.fillStyle = '#86c9ea';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  if (shake > 0.3) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.9; }
  ctx.imageSmoothingEnabled = cam.s < C;
  ctx.drawImage(off, cam.x, cam.y, W * cam.s, H * cam.s);
  const s = cam.s;
  const T = (x, y) => [cam.x + x * s, cam.y + y * s];

  // 自国の輪郭（光る縁取り）
  if (players[me].tiles) {
    strokeOutline(me, 'rgba(255, 214, 140, 0.9)', Math.max(4, s * 0.9));
    strokeOutline(me, '#fffaf0', Math.max(2, s * 0.4));
  }
  // ホバー中の敵国
  const hov = mode === null && hoverTile >= 0 && terrain[hoverTile] ? owner[hoverTile] : -1;
  if (hov >= 0 && hov !== me && state !== 'spawn') strokeOutline(hov, 'rgba(34,34,34,0.8)', Math.max(2, s * 0.3));

  // 核モード：迎撃範囲と爆発範囲
  if (mode && NUKE[mode]) {
    for (const b of bAt.values()) {
      if (b.type !== 'sam' || b.owner === me) continue;
      const [X, Y] = T(b.x + 0.5, b.y + 0.5);
      ctx.beginPath(); ctx.arc(X, Y, SAM_RANGE * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(80,140,255,0.12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(40,90,200,0.6)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
    if (hoverTile >= 0) {
      const [X, Y] = T(hoverTile % W + 0.5, ((hoverTile / W) | 0) + 0.5);
      const r = (mode === 'mirv' ? 15 : NUKE[mode].r) * s;
      ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(217,64,43,0.18)'; ctx.fill();
      ctx.strokeStyle = '#d9402b'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
  // 建設モード：設置プレビュー
  if (mode && BUILD[mode] && hoverTile >= 0) {
    const [X, Y] = T(hoverTile % W, (hoverTile / W) | 0);
    ctx.fillStyle = canPlace(players[me], hoverTile) ? 'rgba(80,200,80,0.6)' : 'rgba(220,60,60,0.6)';
    ctx.fillRect(X, Y, s, s);
    if (mode === 'sam') {
      ctx.beginPath(); ctx.arc(X + s / 2, Y + s / 2, SAM_RANGE * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(40,90,200,0.6)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // 建物（盾型バッジ）
  const bs = Math.max(14, s * 2.6);
  for (const b of bAt.values()) {
    const [X, Y] = T(b.x + 0.5, b.y + 0.5);
    if (X < -bs || Y < -bs || X > cw + bs || Y > ch + bs) continue;
    ctx.beginPath();
    ctx.moveTo(X - bs / 2, Y - bs / 2);
    ctx.lineTo(X + bs / 2, Y - bs / 2);
    ctx.lineTo(X + bs / 2, Y + bs * 0.05);
    ctx.quadraticCurveTo(X + bs / 2, Y + bs * 0.4, X, Y + bs * 0.6);
    ctx.quadraticCurveTo(X - bs / 2, Y + bs * 0.4, X - bs / 2, Y + bs * 0.05);
    ctx.closePath();
    ctx.fillStyle = '#fffdf5'; ctx.fill();
    ctx.strokeStyle = players[b.owner].color; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.font = `${bs * 0.55}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#222';
    ctx.fillText(BUILD[b.type].icon, X, Y + bs * 0.02);
    if (b.type === 'silo' && b.cd > 0) {
      ctx.beginPath(); ctx.arc(X, Y, bs * 0.7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - b.cd / 50));
      ctx.strokeStyle = '#d9402b'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // 国名ラベル（大きい国から順に、重なるものは省略。自国は必ず表示）
  const placed = [];
  const order = players.filter((p) => p.alive && p.tiles).sort((a, b) => (b.id === me) - (a.id === me) || b.tiles - a.tiles);
  for (const p of order) {
    const size = Math.min(18, Math.max(9, Math.sqrt(p.tiles) * s * 0.14));
    if (size < 9.5 && p.id !== me) continue;
    const [X, Y] = T(p.lx, p.ly);
    ctx.font = `800 ${size}px "M PLUS Rounded 1c", sans-serif`;
    const bw = ctx.measureText(p.name).width + size, box = [X - bw / 2, Y - size * 1.4, X + bw / 2, Y + size * 1.5];
    if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);
    pillLabel(p.name, X, Y - size * 0.6, size, p.id === me ? '#fbe7a1' : '#fffdf5', '#222');
    ctx.font = `800 ${size * 0.8}px "M PLUS Rounded 1c", sans-serif`;
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#222';
    ctx.strokeText('🪖' + fmt(p.troops), X, Y + size * 0.9);
    ctx.fillText('🪖' + fmt(p.troops), X, Y + size * 0.9);
  }

  // ミサイル
  for (const m of missiles) {
    const f = Math.min(1, (m.t + acc / TICK_MS * (paused ? 0 : speed)) / m.dur);
    const [TX, TY] = T(m.tx + 0.5, m.ty + 0.5);
    const r = (m.type === 'warhead' ? WARHEAD_R : m.type === 'mirv' ? 15 : NUKE[m.type].r) * s;
    ctx.beginPath(); ctx.arc(TX, TY, r * (0.9 + 0.1 * Math.sin(now / 120)), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(217,64,43,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    for (let k = 0; k <= 20; k++) {
      const p = missilePos(m, f * k / 20), [X, Y] = T(p.x + 0.5, p.y + 0.5);
      k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = 'rgba(80,80,80,0.5)'; ctx.lineWidth = 1; ctx.stroke();
    const p = missilePos(m, f), [X, Y] = T(p.x + 0.5, p.y + 0.5);
    ctx.beginPath(); ctx.arc(X, Y, m.type === 'warhead' ? 3 : 5, 0, Math.PI * 2);
    ctx.fillStyle = m.type === 'hydro' ? '#ff3b6b' : m.type === 'mirv' ? '#b04cff' : '#ff8a00';
    ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.stroke();
    if (m.intercept > 0 && f > m.intercept - 0.25) {    // 迎撃ミサイル
      const g = Math.min(1, (f - (m.intercept - 0.25)) / 0.25);
      const [SX, SY] = T(m.samX + 0.5, m.samY + 0.5);
      ctx.beginPath(); ctx.moveTo(SX, SY); ctx.lineTo(SX + (X - SX) * g, SY + (Y - SY) * g);
      ctx.strokeStyle = '#2f6bff'; ctx.lineWidth = 2; ctx.stroke();
    }
  }

  // 爆発エフェクト
  effects = effects.filter((e) => now - e.start < e.dur);
  for (const e of effects) {
    const t = (now - e.start) / e.dur;
    const [X, Y] = T(e.x + 0.5, e.y + 0.5);
    if (e.kind === 'boom') {
      const R = e.r * s * (0.4 + t * 1.1);
      const grad = ctx.createRadialGradient(X, Y, 0, X, Y, R);
      grad.addColorStop(0, `rgba(255,255,230,${1 - t})`);
      grad.addColorStop(0.4, `rgba(255,170,40,${0.9 * (1 - t)})`);
      grad.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(X, Y, e.r * s * (0.5 + t * 2), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - t)})`; ctx.lineWidth = 4 * (1 - t) + 1; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(X, Y, 4 + t * 20, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(80,140,255,${1 - t})`; ctx.lineWidth = 3; ctx.stroke();
    }
  }
  ctx.restore();
}

function drawSilhouette() {
  const c = $('silhouette'), g = c.getContext('2d'), P = players[me];
  g.clearRect(0, 0, c.width, c.height);
  if (!P.tiles) return;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) if (owner[i] === me) {
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min((c.width - 8) / bw, (c.height - 8) / bh);
  const ox = (c.width - bw * k) / 2, oy = (c.height - bh * k) / 2;
  g.fillStyle = '#222';
  for (let pass = 0; pass < 2; pass++) {
    if (pass) g.fillStyle = P.color;
    const o = pass ? 0 : 1.5;
    for (let i = 0; i < N; i++) if (owner[i] === me) {
      g.fillRect(ox + (i % W - x0) * k - o, oy + (((i / W) | 0) - y0) * k - o, k + o * 2 + 0.5, k + o * 2 + 0.5);
    }
  }
}

// ===== カメラ =====
function fitCamera() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const ui = !$('infoCard').classList.contains('hidden');
  const top = ui ? $('infoCard').getBoundingClientRect().bottom + 24 : 40;
  const bottom = ui ? ch - $('actionBar').getBoundingClientRect().top + 8 : 40;
  cam.s = Math.min(cw / W, (ch - top - bottom) / H) * 0.98;
  cam.s = Math.max(cam.s, Math.min(cw / W, ch / H) * 0.6);
  cam.x = (cw - W * cam.s) / 2;
  cam.y = top + (ch - top - bottom - H * cam.s) / 2;
}
function zoomAt(sx, sy, ns) {
  const minS = Math.min(canvas.clientWidth / W, canvas.clientHeight / H) * 0.5;
  ns = Math.max(minS, Math.min(50, ns));
  cam.x = sx - (sx - cam.x) * ns / cam.s;
  cam.y = sy - (sy - cam.y) * ns / cam.s;
  cam.s = ns;
}
function centerOn(x, y, s) {
  if (s) cam.s = s;
  cam.x = canvas.clientWidth / 2 - x * cam.s;
  cam.y = canvas.clientHeight / 2 - y * cam.s;
}
function screenToTile(sx, sy) {
  const x = Math.floor((sx - cam.x) / cam.s), y = Math.floor((sy - cam.y) / cam.s);
  return x < 0 || y < 0 || x >= W || y >= H ? -1 : y * W + x;
}

// ===== 入力 =====
const pointers = new Map();
let drag = null, pinch = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 1) drag = { sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y, moved: false };
  else if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), s: cam.s };
    if (drag) drag.moved = true;
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse' || pointers.size === 0) {
    const t = screenToTile(e.clientX, e.clientY);
    if (t !== hoverTile) { hoverTile = t; mapDirty = true; }
  }
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
  } else if (drag) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 8) {
      drag.moved = true;
      drag.cx = cam.x - dx; drag.cy = cam.y - dy;
    }
    if (drag.moved && !pinch) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; }
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (drag && !drag.moved && pointers.size === 0 && e.type === 'pointerup') {
    if (e.pointerType !== 'mouse') { hoverTile = screenToTile(e.clientX, e.clientY); mapDirty = true; }
    handleClick(e.clientX, e.clientY, e.button);
  }
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) drag = null;
  else if (drag) drag.moved = true;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, cam.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function handleClick(sx, sy, button) {
  const t = screenToTile(sx, sy);
  if (state === 'spawn') {
    if (t >= 0 && terrain[t]) startGame(t);
    else toast('陸地を選んでね');
    return;
  }
  if (state !== 'play' || t < 0) return;
  const P = players[me];
  if (button === 2) { setMode(null); return; }
  if (mode && BUILD[mode]) {
    const err = placeBuilding(P, mode, t);
    if (err) toast(err); else { log(`${BUILD[mode].name}を建設した`, me); setMode(null); }
    return;
  }
  if (mode && NUKE[mode]) {
    const err = launchNuke(P, mode, t);
    if (err) toast(err);
    setMode(null);
    return;
  }
  if (!terrain[t]) return;
  const o = owner[t];
  if (o === me) return;
  if (!P.nb.has(o)) { toast(o < 0 ? 'そこには隣接していません' : `${players[o].name}とは隣接していません`); return; }
  const send = Math.floor(P.troops * ratio());
  if (send < 10) { toast('兵力が足りません'); return; }
  P.troops -= send;
  launchAttack(me, o, send);
  ripple(t);
}
function ripple(t) { effects.push({ kind: 'pop', x: t % W, y: (t / W) | 0, start: performance.now(), dur: 500 }); }
const ratio = () => parseInt($('ratio').value, 10) / 100;

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
  if (e.key === 'Escape') setMode(null);
  else if (e.key === 'p' || e.key === 'P') togglePause();
  else if (state === 'play') {
    for (const [k, v] of Object.entries({ ...BUILD, ...NUKE })) if (v.key === e.key) setMode(mode === k ? null : k);
  }
});

function setMode(m) {
  mode = m;
  document.querySelectorAll('.bbtn').forEach((b) => b.classList.toggle('active', b.dataset.type === m));
  if (!m) setHint(null);
  else if (BUILD[m]) setHint(`${BUILD[m].icon} ${BUILD[m].name}を建てる場所をタップ`, true);
  else setHint(`${NUKE[m].icon} ${NUKE[m].name}の目標をタップ`, true);
  mapDirty = true;
}

// ===== UI =====
function buildButtons() {
  const box = $('buttons');
  box.innerHTML = '';
  for (const [k, v] of Object.entries({ ...BUILD, ...NUKE })) {
    const b = document.createElement('button');
    b.className = 'bbtn' + (NUKE[k] ? ' nuke' : '');
    b.dataset.type = k;
    b.innerHTML = `<span class="ic">${v.icon}</span><span class="nm">${v.name}</span><span class="cs"></span>`;
    b.title = `${v.name} [${v.key}]`;
    b.addEventListener('click', () => { if (state === 'play') setMode(mode === k ? null : k); });
    box.appendChild(b);
  }
}

let lastSil = -1, sheetTab = null;
function updateUI() {
  if (!players) return;
  const P = players[me];
  $('cName').textContent = P.name;
  $('cSub').textContent = '・' + diff.label;
  const ranked = players.filter((p) => p.alive).sort((a, b) => b.tiles - a.tiles);
  const rank = ranked.indexOf(P) + 1;
  $('cRank').textContent = P.alive ? `${rank}位` : '滅亡';
  $('cTiles').textContent = P.tiles;
  const d = tileHistory.length ? P.tiles - tileHistory[0] : 0;
  $('cDelta').textContent = (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);
  $('cTroops').textContent = fmt(P.troops);
  $('cMax').textContent = fmt(maxTroops(P));
  $('cGold').textContent = fmt(P.gold);
  $('cIncome').textContent = Math.round(goldRate(P) * 10);
  $('cAttack').textContent = fmt(attacks.filter((a) => a.a === me).reduce((s, a) => s + a.troops, 0));
  $('cTime').textContent = timeStr(tick);
  const incoming = missiles.some((m) => m.owner !== me && (m.victim === me || (m.type === 'warhead' && owner[m.ty * W + m.tx] === me)));
  $('nukeAlert').classList.toggle('hidden', !incoming);

  for (const b of document.querySelectorAll('.bbtn')) {
    const k = b.dataset.type;
    const cost = BUILD[k] ? buildCost(P, k) : NUKE[k].cost;
    b.querySelector('.cs').textContent = '💰' + fmt(cost);
    b.disabled = state !== 'play' || P.gold < cost || (NUKE[k] && !P.cnt.silo);
  }
  if (tick !== lastSil && tick % 10 === 0) { lastSil = tick; drawSilhouette(); }
  if (sheetTab === 'rank') renderRank();
  if (sheetTab === 'recent') renderRecent();
}

function renderRank() {
  const list = players.slice().sort((a, b) => (b.alive - a.alive) || (b.tiles - a.tiles));
  $('sheet').innerHTML = '<h3>順位</h3>' + list.map((p, k) => `
    <div class="rk ${p.id === me ? 'me' : ''} ${p.alive ? '' : 'dead'}">
      <span class="no">${p.alive ? k + 1 + '位' : '—'}</span>
      <span class="sw" style="background:${p.color}"></span>
      <span class="nm">${esc(p.name)}</span>
      <span class="v">${p.tiles}マス</span>
      <span class="v">🪖${fmt(p.troops)}</span>
      <span class="v">${(p.tiles / landCount * 100).toFixed(1)}%</span>
    </div>`).join('');
}
function renderRecent() {
  $('sheet').innerHTML = '<h3>最近のできごと</h3>' + (logs.length ? logs.slice().reverse().slice(0, 40).map((l) => `
    <div class="lg ${l.cls}"><span class="sw" style="background:${l.color}"></span>${esc(l.text)}<span class="ago">${ago(l.tick)}</span></div>`).join('') : '<p>まだ何も起きていません</p>');
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function ago(t) { const s = Math.floor((tick - t) / 10); return s < 5 ? 'いま' : s < 60 ? `${s}秒前` : `${Math.floor(s / 60)}分前`; }

function log(text, pid, cls = '') {
  const color = pid != null && players[pid] ? players[pid].color : '#ccc';
  logs.push({ text, color, cls, tick });
  if (logs.length > 100) logs.shift();
  ticker(text, color);
}
function ticker(text, color) {
  $('ticker').querySelector('.tx').textContent = text;
  $('ticker').querySelector('.sw').style.background = color || '#ccc';
}
setInterval(() => { if (logs && logs.length) $('ticker').querySelector('.ago').textContent = ago(logs[logs.length - 1].tick); }, 1000);

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1600);
}
function setHint(msg, top) {
  const h = $('hint');
  if (!msg) { h.classList.add('hidden'); return; }
  h.textContent = msg; h.classList.remove('hidden'); h.classList.toggle('top', !!top);
}

function openSheet(tab) {
  if (tab === 'map') { fitCamera(); closeSheet(); return; }
  if (sheetTab === tab) { closeSheet(); return; }
  sheetTab = tab;
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('sheet').classList.remove('hidden');
  if (tab === 'help') $('sheet').innerHTML = $('helpTpl').innerHTML;
  updateUI();
}
function closeSheet() {
  sheetTab = null;
  $('sheet').classList.add('hidden');
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.remove('active'));
}
document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => openSheet(b.dataset.tab)));

function togglePause() {
  if (state !== 'play' && state !== 'watch') return;
  paused = !paused;
  $('btnPause').textContent = paused ? '▶' : '⏸';
  setHint(paused ? '⏸ 一時停止中' : null);
}

$('ratio').addEventListener('input', () => { $('ratioVal').textContent = $('ratio').value + '%'; });
$('btnStart').addEventListener('click', newGame);
$('btnRestart').addEventListener('click', () => {
  $('endCard').classList.add('hidden');
  $('menu').classList.remove('hidden');
});
$('btnWatch').addEventListener('click', () => { state = 'watch'; $('overlay').classList.add('hidden'); });
$('btnZoomIn').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s * 1.3));
$('btnZoomOut').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s / 1.3));
$('btnHome').addEventListener('click', () => { const P = players[me]; if (P.tiles) centerOn(P.lx, P.ly, Math.max(cam.s, 10)); });
$('btnSpeed').addEventListener('click', () => {
  speed = speed === 1 ? 2 : speed === 2 ? 4 : 1;
  $('btnSpeed').innerHTML = `速度<br>${speed}x`;
});
$('btnPause').addEventListener('click', togglePause);
$('btnCollapse').addEventListener('click', () => {
  const c = $('infoCard').classList.toggle('collapsed');
  $('btnCollapse').textContent = c ? '▼' : '▲';
});
window.addEventListener('resize', () => { if (state === 'menu' || state === 'spawn') fitCamera(); });

// タイトル画面の背景用にマップを生成しておく
setDims();
genMap((Math.random() * 1e9) | 0);
owner = new Int16Array(N).fill(-1);
fallout = new Float32Array(N);
bAt = new Map(); attacks = []; missiles = []; effects = []; logs = [];
players = [makePlayer(0, '', ME_COLOR, false)];
fitCamera();
requestAnimationFrame(frame);

// テスト・デバッグ用
window.__jintori = {
  get players() { return players; }, get state() { return state; }, get missiles() { return missiles; },
  get W() { return W; }, owner: () => owner, launchNuke, placeBuilding, step, launchAttack,
};
})();
