'use strict';
(() => {
// ===== 定数 =====
let W = 30, H = 20, N = W * H;        // マップのマス数（縦長画面では縦長マップ）
const C = 12;                         // オフスクリーン描画での1マスのピクセル数
const SEASON_DAYS = 100;
const WIN_SHARE = 0.6;
const SAM_RANGE = 5;
const SILO_RELOAD = 2;                // 日
const SAM_RELOAD = 3;                 // 日

const BUILD = {
  city: { name: '都市',        icon: '🏙', base: 40,  scale: 1.0, key: '1' },
  silo: { name: 'ミサイル基地', icon: '🚀', base: 100, scale: 1.0, key: '2' },
  sam:  { name: '迎撃基地',    icon: '🛡', base: 70,  scale: 0.6, key: '3' },
};
const NUKE = {
  atom:  { name: '原子爆弾', icon: '☢', cost: 120, r: 1.5, fallout: 3, key: '4' },
  hydro: { name: '水素爆弾', icon: '💥', cost: 300, r: 3,   fallout: 5, key: '5' },
  mirv:  { name: 'MIRV',    icon: '🎆', cost: 700, r: 6,   fallout: 3, key: '6', warheads: 6 },
};
const WARHEAD_R = 1.2;

const DIFF = {
  easy:   { label: 'かんたん',  skip: 0.3, extraEvery: 0, hateMe: 0.1,  nukeStart: 30, nukeRate: 0.05, defend: 0.25 },
  normal: { label: 'ふつう',    skip: 0.1, extraEvery: 0, hateMe: 0.25, nukeStart: 20, nukeRate: 0.1,  defend: 0.35 },
  hard:   { label: 'むずかしい', skip: 0,   extraEvery: 3, hateMe: 0.4,  nukeStart: 14, nukeRate: 0.18, defend: 0.45 },
};

const ME_COLOR = '#8a6cf0';
const PALETTE = ['#f6d55c', '#ef8fd6', '#6cc36a', '#f39a5b', '#4f8fe0', '#e86a6a', '#42c2b0', '#b48a5e',
  '#c39af0', '#9bd14b', '#ff7fa8', '#8c9db5', '#e0b03a', '#5ca86c'];
const BOT_NAMES = ['ねこ県', 'いぬ市', 'たぬき町', 'きつね村', 'うさぎ王国', 'くま共和国', 'ぺんぎん連邦',
  'かっぱ国', 'からす藩', 'さる県', 'しか市', 'ぶた町', 'かめ公国', 'たこ帝国'];

// ===== 状態 =====
let terrain, elev, owner, shield, fallout, baseRGB, prov, provinces, peak;
let players, bAt, missiles, effects, logs;
let state = 'menu', day = 1, landCount = 0, diff = DIFF.normal;
let me = 0, mode = null, hoverTile = -1, selTile = -1, shake = 0, mapDirty = true, showLabels = true;
let yesterdayTiles = 0;
const cam = { x: 0, y: 0, s: 16 };

const $ = (id) => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');
let img, pix;
function setDims() {
  const portrait = window.innerHeight > window.innerWidth * 1.1;
  [W, H] = portrait ? [20, 30] : [30, 20];
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
  if (n >= 1e4) return Math.round(n / 1e3) + 'k';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return Math.round(n).toString();
}
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const tx = (i) => i % W, ty = (i) => (i / W) | 0;
function neighbors(i) {
  const x = i % W, out = [];
  if (x > 0) out.push(i - 1);
  if (x < W - 1) out.push(i + 1);
  if (i >= W) out.push(i - W);
  if (i < N - W) out.push(i + W);
  return out;
}
const town = (i) => (prov[i] >= 0 ? provinces[prov[i]].name : '海');

// ===== マップ生成 =====
function genMap(seed) {
  const r = mulberry32(seed);
  const makeNoise = (cell) => {
    const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
    const g = new Float32Array(gw * gh);
    for (let k = 0; k < g.length; k++) g[k] = r();
    return (x, y) => {
      const fx = x / cell, fy = y / cell, ix = fx | 0, iy = fy | 0;
      const ax = fx - ix, ay = fy - iy;
      const sx = ax * ax * (3 - 2 * ax), sy = ay * ay * (3 - 2 * ay);
      const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
      return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    };
  };
  const oct = [[7, 1], [3.5, 0.5], [1.8, 0.2]].map(([c, w]) => [makeNoise(c), w]);
  const h = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let v = 0;
    for (const [f, w] of oct) v += f(x, y) * w;
    v /= 1.7;
    const dx = (x / (W - 1) - 0.5) * 2, dy = (y / (H - 1) - 0.5) * 2;
    v -= (dx * dx + dy * dy) * 0.35;
    h[y * W + x] = v;
  }
  const sorted = Array.from(h).sort((a, b) => a - b);
  const thr = sorted[Math.floor(N * 0.42)], top = sorted[N - 1];
  terrain = new Uint8Array(N);
  for (let i = 0; i < N; i++) terrain[i] = h[i] > thr ? 1 : 0;

  // 最大の大陸だけを残す
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
    if (!terrain[i]) { const d = elev[i]; c = [72 - d * 18, 90 - d * 22, 170 - d * 30]; }
    else if (elev[i] > 0.7) c = [226, 214, 186];   // 山地
    else { const e = elev[i]; c = [246 - e * 12, 240 - e * 10, 222 - e * 18]; }
    baseRGB.set(c.map(Math.round), i * 3);
  }

  // 町：陸地に中心点を散らし、座標を少し歪ませて一番近い中心に割り当てる
  const warpX = makeNoise(3), warpY = makeNoise(3);
  provinces = [];
  const K = Math.max(8, Math.round(landCount / 9)), used = new Set();
  for (let tries = 0; provinces.length < K && tries < 20000; tries++) {
    const i = Math.floor(r() * N);
    if (!terrain[i]) continue;
    if (provinces.every((p) => Math.hypot(p.x - tx(i), p.y - ty(i)) > 2.6)) {
      provinces.push({ x: tx(i), y: ty(i), name: townName(r, used), land: 0, sx: 0, sy: 0 });
    }
  }
  prov = new Int16Array(N).fill(-1);
  peak = -1;
  for (let i = 0; i < N; i++) {
    if (!terrain[i]) continue;
    const x = tx(i), y = ty(i);
    const wx = x + (warpX(x, y) - 0.5) * 2.5, wy = y + (warpY(x, y) - 0.5) * 2.5;
    let bk = 0, bd = Infinity;
    for (let k = 0; k < provinces.length; k++) {
      const d = (provinces[k].x - wx) ** 2 + (provinces[k].y - wy) ** 2;
      if (d < bd) { bd = d; bk = k; }
    }
    prov[i] = bk;
    const P = provinces[bk];
    P.land++; P.sx += x; P.sy += y;
    if (peak < 0 || elev[i] > elev[peak]) peak = i;
  }
  for (const P of provinces) if (P.land) { P.lx = P.sx / P.land + 0.5; P.ly = P.sy / P.land + 0.5; }
}
const TOWN_A = ['桜', '松', '竹', '梅', '青', '白', '赤', '黒', '大', '小', '高', '長', '北', '南', '東', '西', '新', '古',
  '森', '石', '鳥', '鹿', '花', '月', '星', '金', '銀', '風', '雪', '霧', '虹', '柿', '栗', '蛍'];
const TOWN_B = ['ヶ丘', '見', '原', '沢', '田', '島', '崎', '浦', '野', '谷', '瀬', '岡', '宮', '津', '浜', '山', '川', '台', '里', '根'];
const TOWN_C = ['市', '町', '町', '村'];
function townName(r, used) {
  for (;;) {
    const n = TOWN_A[Math.floor(r() * TOWN_A.length)] + TOWN_B[Math.floor(r() * TOWN_B.length)];
    if (used.has(n)) continue;
    used.add(n);
    return n + TOWN_C[Math.floor(r() * TOWN_C.length)];
  }
}

// ===== プレイヤー =====
function makePlayer(id, name, color, isBot) {
  return {
    id, name, color, rgb: hex2rgb(color), isBot, alive: true,
    gold: 30, tiles: 0, cnt: { city: 0, silo: 0, sam: 0 }, actions: 1, capital: -1,
    nb: new Set(), lx: 0, ly: 0, grudge: -1,
  };
}
const goldRate = (p) => 2 + p.tiles + p.cnt.city * 4;
const buildCost = (p, type) => Math.round(BUILD[type].base * (1 + BUILD[type].scale * p.cnt[type]));
const shieldCount = (p) => { let n = 0; for (let i = 0; i < N; i++) if (owner[i] === p.id && shield[i]) n++; return n; };

function setOwner(i, o) {
  const old = owner[i];
  if (old === o) return;
  if (old >= 0) players[old].tiles--;
  owner[i] = o;
  shield[i] = 0;
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
  shield = new Uint8Array(N);
  fallout = new Uint8Array(N);
  bAt = new Map(); missiles = []; effects = []; logs = [];
  players = [makePlayer(0, $('optName').value.trim() || 'あなたの国', ME_COLOR, false)];
  const names = shuffle(BOT_NAMES.slice()), cols = shuffle(PALETTE.slice());
  for (let k = 0; k < nBots; k++) players.push(makePlayer(k + 1, names[k], cols[k], true));
  me = 0; day = 1; mode = null; selTile = -1;
  state = 'spawn';
  mapDirty = true;
  $('overlay').classList.add('hidden');
  $('endCard').classList.add('hidden');
  ['infoCard', 'sideBtns', 'bottom'].forEach((id) => $(id).classList.remove('hidden'));
  closeSheet();
  hideSel();
  fitCamera();
  setHint('🏁 スタート地点をタップしてね');
  ticker('スタート地点を選んでください', null);
  buildButtons();
  updateUI();
}

function claimSpawn(p, i) {
  p.capital = i;
  setOwner(i, p.id);
  for (const j of neighbors(i)) if (terrain[j] && owner[j] < 0) setOwner(j, p.id);
}

function startGame(spawnTile) {
  claimSpawn(players[me], spawnTile);
  const spawns = [spawnTile];
  for (const p of players) {
    if (p.id === me) continue;
    let minD = Math.sqrt(landCount / players.length) * 1.1, placed = false;
    for (let tries = 0; tries < 5000 && !placed; tries++) {
      if (tries % 300 === 299) minD *= 0.85;
      const i = Math.floor(Math.random() * N);
      if (!terrain[i] || owner[i] >= 0) continue;
      if (neighbors(i).some((j) => owner[j] >= 0)) continue;
      if (spawns.every((s) => Math.hypot(tx(s) - tx(i), ty(s) - ty(i)) >= minD)) {
        claimSpawn(p, i); spawns.push(i); placed = true;
      }
    }
    if (!placed) p.alive = false;
  }
  scan();
  yesterdayTiles = players[me].tiles;
  state = 'play';
  setHint(null);
  log(`${players[me].name} が ${town(spawnTile)} に建国しました！`, me, 'good');
  centerOn(tx(spawnTile) + 0.5, ty(spawnTile) + 0.5);
  updateUI();
}

// ===== 1日の行動 =====
const adjacentTo = (i, pid) => neighbors(i).some((j) => owner[j] === pid);
function canTake(p, i) {
  if (i < 0 || !terrain[i]) return '海は取れません';
  if (owner[i] === p.id) return '自分のマスです';
  if (fallout[i] > 0) return `放射能汚染中（あと${fallout[i]}日）`;
  if (!adjacentTo(i, p.id)) return '自分の陣地のとなりのマスしか取れません';
  return null;
}
// 取る。盾があれば盾がこわれるだけ。戻り値：'took' | 'blocked'
function takeTile(p, i) {
  const o = owner[i];
  if (o >= 0 && shield[i]) {
    shield[i] = 0;
    mapDirty = true;
    pop(i, '#ffffff');
    log(`${players[o].name}が ${town(i)} を守った（${p.name}の攻撃）`, o, o === me ? 'good' : p.id === me ? 'warn' : '');
    return 'blocked';
  }
  setOwner(i, p.id);
  pop(i, p.color);
  if (o === me) log(`${p.name}に ${town(i)} を取られた！`, p.id, 'warn');
  else log(`${p.name}が ${town(i)} を取った`, p.id, p.id === me ? 'good' : '');
  if (o >= 0 && players[o].isBot) players[o].grudge = p.id;
  return 'took';
}
function guardTile(p, i) {
  shield[i] = 1;
  mapDirty = true;
  pop(i, '#ffffff');
  log(`${p.name}が ${town(i)} を守った`, p.id, p.id === me ? 'good' : '');
}

// プレイヤーの1マス
function doPlayerAction(i) {
  const P = players[me];
  if (state !== 'play' || P.actions <= 0) return;
  if (owner[i] === me) {
    if (shield[i]) { toast('もう守っています'); return; }
    guardTile(P, i);
  } else {
    const err = canTake(P, i);
    if (err) { toast(err); return; }
    takeTile(P, i);
  }
  P.actions--;
  hideSel();
  scan();
  updateUI();
  if (P.actions <= 0 && state === 'play') {
    state = 'busy';
    setTimeout(advanceDay, 550);
  }
}

// 1日を進める：CPUが動き、金が入り、汚染が薄れる
function advanceDay() {
  if (state !== 'busy') return;
  const bots = shuffle(players.filter((p) => p.isBot && p.alive));
  bots.forEach((p, k) => {
    let n = Math.random() < diff.skip ? 0 : 1;
    if (diff.extraEvery && day % diff.extraEvery === 0) n++;
    for (let a = 0; a < n; a++) botAct(p);
    botEconomy(p, k);
  });
  day++;
  for (const p of players) if (p.alive) { p.gold += goldRate(p); p.actions = 1; }
  for (let i = 0; i < N; i++) if (fallout[i] > 0) { fallout[i]--; mapDirty = true; }
  for (const b of bAt.values()) if (b.cd > 0) b.cd--;
  yesterdayTiles = players[me].tiles;
  scan();
  state = 'play';
  checkEnd();
  updateUI();
}

// ===== AI =====
function botAct(p) {
  const neutral = [], enemy = [], threatened = [];
  for (let i = 0; i < N; i++) {
    if (!terrain[i]) continue;
    const o = owner[i];
    if (o === p.id) {
      if (!shield[i] && neighbors(i).some((j) => terrain[j] && owner[j] >= 0 && owner[j] !== p.id)) threatened.push(i);
      continue;
    }
    if (fallout[i] > 0 || !adjacentTo(i, p.id)) continue;
    (o < 0 ? neutral : enemy).push(i);
  }
  const ownN = (i) => neighbors(i).filter((j) => owner[j] === p.id).length;
  const best = (arr, score) => { let b = -1, bs = -Infinity; for (const i of arr) { const s = score(i) + Math.random(); if (s > bs) { bs = s; b = i; } } return b; };

  // 守る：首都や建物、敵に多く面しているマスを優先
  if (threatened.length && Math.random() < diff.defend * (neutral.length ? 0.5 : 1)) {
    const i = best(threatened, (i) => neighbors(i).filter((j) => owner[j] >= 0 && owner[j] !== p.id).length + (bAt.has(i) || i === p.capital ? 2 : 0));
    guardTile(p, i);
    return;
  }
  if (neutral.length && (!enemy.length || Math.random() < 0.75)) {
    takeTile(p, best(neutral, (i) => ownN(i) * 1.5));
    return;
  }
  if (enemy.length) {
    const foes = [...new Set(enemy.map((i) => owner[i]))];
    let target;
    if (p.grudge >= 0 && foes.includes(p.grudge) && Math.random() < 0.6) target = p.grudge;
    else if (foes.includes(me) && Math.random() < diff.hateMe) target = me;
    else target = foes.reduce((a, b) => (players[b].tiles < players[a].tiles ? b : a));
    const cand = enemy.filter((i) => owner[i] === target);
    takeTile(p, best(cand, (i) => ownN(i) * 1.5 - shield[i] * 2 + (bAt.has(i) ? 1.5 : 0)));
    return;
  }
  if (threatened.length) guardTile(p, pick(threatened));
}

function botEconomy(p, k) {
  // 建設
  let type = null;
  if (day > diff.nukeStart * 0.6 && p.tiles >= 12 && p.cnt.silo < 1 + Math.floor(p.tiles / 60)) type = 'silo';
  else if (p.cnt.silo && p.cnt.sam < p.cnt.silo) type = 'sam';
  else if (p.cnt.city < 1 + p.tiles / 15) type = 'city';
  const reserve = p.cnt.silo && type === 'city' ? NUKE.atom.cost : 0;
  if (type && p.gold >= buildCost(p, type) + reserve) {
    const own = [];
    for (let i = 0; i < N; i++) if (owner[i] === p.id && !bAt.has(i)) own.push(i);
    const inner = own.filter((i) => neighbors(i).every((j) => owner[j] === p.id));
    const spot = pick(inner.length ? inner : own);
    if (spot !== undefined) placeBuilding(p, type, spot);
  }
  // 核
  if (!p.cnt.silo || day < diff.nukeStart || Math.random() > diff.nukeRate) return;
  let nt = null;
  if (p.gold >= NUKE.mirv.cost && Math.random() < 0.3) nt = 'mirv';
  else if (p.gold >= NUKE.hydro.cost && Math.random() < 0.6) nt = 'hydro';
  else if (p.gold >= NUKE.atom.cost) nt = 'atom';
  if (!nt) return;
  const others = players.filter((q) => q.alive && q.id !== p.id && q.tiles > 0);
  if (!others.length) return;
  let t = p.grudge >= 0 && players[p.grudge].alive ? players[p.grudge] : null;
  if (!t) t = players[me].alive && Math.random() < diff.hateMe ? players[me] : others.reduce((a, b) => (b.tiles > a.tiles ? b : a));
  const cities = [...bAt.values()].filter((b) => b.owner === t.id);
  let ti;
  if (cities.length && Math.random() < 0.5) ti = pick(cities).i;
  else {
    const own = [];
    for (let i = 0; i < N; i++) if (owner[i] === t.id) own.push(i);
    ti = pick(own);
  }
  if (ti !== undefined) launchNuke(p, nt, ti, k * 350);
}

// ===== 建設 =====
function canPlace(p, i) {
  if (i < 0 || owner[i] !== p.id) return '自分のマスに建ててください';
  if (bAt.has(i)) return 'そのマスにはもう建物があります';
  return null;
}
function placeBuilding(p, type, i) {
  const cost = buildCost(p, type);
  if (p.gold < cost) return '金が足りません';
  const err = canPlace(p, i);
  if (err) return err;
  p.gold -= cost;
  bAt.set(i, { type, i, x: tx(i), y: ty(i), owner: p.id, cd: 0 });
  p.cnt[type]++;
  if (p.id === me) log(`${town(i)} に${BUILD[type].name}を建てた`, me, 'good');
  return null;
}

// ===== 核 =====
function readySilo(p, x, y) {
  let best = null, bd = Infinity;
  for (const b of bAt.values()) {
    if (b.owner !== p.id || b.type !== 'silo' || b.cd > 0) continue;
    const d = Math.hypot(b.x - x, b.y - y);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
function launchNuke(p, type, ti, delay = 0) {
  const NK = NUKE[type];
  if (p.gold < NK.cost) return '金が足りません';
  if (!p.cnt.silo) return 'ミサイル基地がありません';
  const x = tx(ti), y = ty(ti);
  const silo = readySilo(p, x, y);
  if (!silo) return 'ミサイル基地が再装填中です';
  p.gold -= NK.cost;
  silo.cd = SILO_RELOAD;
  const dist = Math.hypot(x - silo.x, y - silo.y);
  const victim = terrain[ti] ? owner[ti] : -1;
  const m = { type, owner: p.id, sx: silo.x, sy: silo.y, tx: x, ty: y, start: performance.now() + delay, dur: 1100 + dist * 70, victim, intercept: -1 };
  if (type !== 'mirv') {
    for (const b of bAt.values()) {
      if (b.type !== 'sam' || b.owner === p.id || b.cd > 0) continue;
      if (Math.hypot(b.x - x, b.y - y) <= SAM_RANGE) {
        m.intercept = 0.82; m.samX = b.x; m.samY = b.y; m.samOwner = b.owner; b.cd = SAM_RELOAD;
        break;
      }
    }
  }
  missiles.push(m);
  if (victim >= 0 && players[victim].isBot && victim !== p.id) players[victim].grudge = p.id;
  if (victim === me) log(`☢ ${p.name} があなたの ${town(ti)} に${NK.name}を発射！`, p.id, 'warn');
  else if (p.id === me) log(`${town(ti)} に${NK.name}を発射！`, me);
  else log(`${p.name} が${victim >= 0 ? players[victim].name + 'の ' : ''}${town(ti)} に${NK.name}を発射`, p.id);
  return null;
}

function updateMissiles(now) {
  const spawned = [];
  for (const m of missiles) {
    const f = (now - m.start) / m.dur;
    if (f < 0) continue;
    if (m.intercept > 0 && f >= m.intercept) {
      m.dead = true;
      const pos = missilePos(m, m.intercept);
      effects.push({ kind: 'pop', x: pos.x, y: pos.y, start: performance.now(), dur: 700, color: '#5b8cff' });
      if (m.samOwner === me) log(`🛡 迎撃成功！${players[m.owner].name}の${NUKE[m.type].name}を撃墜`, me, 'good');
      else if (m.owner === me) log(`${players[m.samOwner].name}に迎撃された…`, m.samOwner);
      continue;
    }
    if (f < 1) continue;
    m.dead = true;
    if (m.type === 'mirv') spawned.push(...splitMirv(m, now));
    else if (m.type === 'warhead') detonate(m.tx, m.ty, WARHEAD_R, NUKE.mirv.fallout, m.owner);
    else detonate(m.tx, m.ty, NUKE[m.type].r, NUKE[m.type].fallout, m.owner);
  }
  if (missiles.some((m) => m.dead) || spawned.length) {
    missiles = missiles.filter((m) => !m.dead).concat(spawned);
    scan(); checkEnd(); updateUI();
  }
}
function splitMirv(m, now) {
  let targets = [];
  if (m.victim >= 0) for (let i = 0; i < N; i++) if (owner[i] === m.victim) targets.push(i);
  targets = shuffle(targets).slice(0, NUKE.mirv.warheads);
  while (targets.length < NUKE.mirv.warheads) {
    const x = Math.round(m.tx + (Math.random() - 0.5) * 8), y = Math.round(m.ty + (Math.random() - 0.5) * 8);
    if (x >= 0 && y >= 0 && x < W && y < H) targets.push(y * W + x);
  }
  return targets.map((ti) => ({
    type: 'warhead', owner: m.owner, sx: m.tx, sy: m.ty, tx: tx(ti), ty: ty(ti),
    start: now, dur: 500 + Math.hypot(tx(ti) - m.tx, ty(ti) - m.ty) * 60, intercept: -1,
  }));
}
function detonate(x0, y0, r, days, by) {
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
    const x = x0 + dx, y = y0 + dy;
    if (x < 0 || y < 0 || x >= W || y >= H || Math.hypot(dx, dy) > r) continue;
    const i = y * W + x;
    if (!terrain[i]) continue;
    fallout[i] = Math.max(fallout[i], days);
    const o = owner[i];
    if (o >= 0) {
      setOwner(i, -1);
      if (players[o].isBot && o !== by) players[o].grudge = by;
    }
    bAt.delete(i);
  }
  for (const p of players) p.cnt = { city: 0, silo: 0, sam: 0 };
  for (const b of bAt.values()) players[b.owner].cnt[b.type]++;
  effects.push({ kind: 'boom', x: x0, y: y0, r, start: performance.now(), dur: 1500 });
  shake = Math.min(18, shake + r * 5);
  mapDirty = true;
}
function missilePos(m, f) {
  const dist = Math.hypot(m.tx - m.sx, m.ty - m.sy);
  return { x: m.sx + (m.tx - m.sx) * f, y: m.sy + (m.ty - m.sy) * f - Math.sin(Math.PI * f) * Math.min(6, dist * 0.35) };
}

// ===== スキャン（隣接関係・ラベル位置・滅亡） =====
function scan() {
  const sums = players.map(() => [0, 0]);
  const inner = players.map(() => []);
  for (const p of players) p.nb = new Set();
  for (let i = 0; i < N; i++) {
    const o = owner[i];
    if (o < 0) continue;
    sums[o][0] += tx(i); sums[o][1] += ty(i);
    let isInner = true;
    for (const j of neighbors(i)) {
      if (!terrain[j]) continue;
      if (owner[j] !== o) { players[o].nb.add(owner[j]); isInner = false; }
    }
    if (isInner) inner[o].push(i);
  }
  for (const p of players) {
    if (!p.tiles) continue;
    const cx = sums[p.id][0] / p.tiles, cy = sums[p.id][1] / p.tiles;
    // 重心に一番近い自分のマスにラベルを置く（凹んだ形でも陣地内に表示される）
    let bi = -1, bd = Infinity;
    const pool = inner[p.id];
    if (!pool.length) for (let i = 0; i < N; i++) if (owner[i] === p.id) pool.push(i);
    for (const i of pool) {
      const d = Math.hypot(tx(i) - cx, ty(i) - cy);
      if (d < bd) { bd = d; bi = i; }
    }
    p.lx = tx(bi) + 0.5; p.ly = ty(bi) + 0.5;
  }
  for (const p of players) {
    if (p.alive && p.tiles === 0 && state !== 'spawn' && state !== 'menu') {
      p.alive = false;
      log(p.id === me ? 'あなたの国は滅亡しました…' : `${p.name} が滅亡した！`, p.id, p.id === me ? 'warn' : '');
    }
  }
}

function ranking() { return players.slice().sort((a, b) => (b.alive - a.alive) || (b.tiles - a.tiles)); }
function checkEnd() {
  if (state !== 'play' && state !== 'busy') return;
  const P = players[me];
  const bots = players.filter((p) => p.isBot && p.alive);
  const leader = ranking()[0];
  if (!P.alive) endGame(false, `あなたの国は${day}日目に滅ぼされてしまった…`);
  else if (P.tiles >= landCount * WIN_SHARE) endGame(true, `${day}日目に陸地の${Math.round(P.tiles / landCount * 100)}%を手に入れた！`);
  else if (!bots.length) endGame(true, `${day}日目にすべての敵国を滅ぼした！`);
  else if (leader.id !== me && leader.tiles >= landCount * WIN_SHARE) endGame(false, `${leader.name}が陸地の60%を支配してしまった…`);
  else if (day > SEASON_DAYS) {
    const rank = ranking().indexOf(P) + 1;
    endGame(rank === 1, rank === 1 ? `シーズン終了！${P.tiles}マスで1位！` : `シーズン終了…${P.tiles}マスで${rank}位（1位は${leader.name}の${leader.tiles}マス）`);
  }
}
function endGame(win, text) {
  state = win ? 'won' : 'lost';
  hideSel();
  setMode(null);
  $('endTitle').textContent = win ? '🎉 勝利！' : '💀 敗北…';
  $('endText').textContent = text;
  $('menu').classList.add('hidden');
  $('endCard').classList.remove('hidden');
  $('overlay').classList.remove('hidden');
}

// ===== メインループ =====
function frame(now) {
  if (missiles.length) updateMissiles(now);
  render(now);
  requestAnimationFrame(frame);
}

// ===== 描画 =====
const mix = (a, b, t) => a + (b - a) * t;
function renderMap() {
  const rowW = W * C;
  for (let i = 0; i < N; i++) {
    const cx = tx(i) * C, cy = ty(i) * C, o = owner[i];
    let r = baseRGB[i * 3], g = baseRGB[i * 3 + 1], b = baseRGB[i * 3 + 2];
    const striped = o >= 0;
    if (striped) [r, g, b] = players[o].rgb;
    if (fallout[i] > 0) { const f = Math.min(0.75, 0.3 + fallout[i] * 0.1); r = mix(r, 150, f); g = mix(g, 220, f); b = mix(b, 40, f); }
    const water = !terrain[i], x = tx(i);
    const rightB = !water && x < W - 1 && terrain[i + 1] && prov[i + 1] !== prov[i];
    const downB = !water && i < N - W && terrain[i + W] && prov[i + W] !== prov[i];
    for (let py = 0; py < C; py++) {
      let p = ((cy + py) * rowW + cx) * 4;
      for (let px = 0; px < C; px++, p += 4) {
        let R = r, G = g, B = b;
        if ((rightB && px >= C - 2) || (downB && py >= C - 2)) {   // 町の境界線
          R = mix(R, 255, 0.85); G = mix(G, 255, 0.85); B = mix(B, 255, 0.85);
        } else if (px === C - 1 || py === C - 1) {                // マス目の線
          const k = water ? 0.97 : 0.84;
          R *= k; G *= k; B *= k;
        } else if (striped && (px + C - py) % 6 < 1.5) {          // 斜線模様
          R = mix(R, 255, 0.2); G = mix(G, 255, 0.2); B = mix(B, 255, 0.2);
        }
        pix[p] = R; pix[p + 1] = G; pix[p + 2] = B; pix[p + 3] = 255;
      }
    }
  }
  octx.putImageData(img, 0, 0);
  // 海の波模様
  octx.beginPath();
  for (let y = 1; y < H; y += 2) {
    for (let x = (y >> 1) & 1 ? 2 : 0; x < W; x += 3) {
      const i = y * W + x;
      if (terrain[i]) continue;
      const X = (x + 0.5) * C, Y = (y + 0.5) * C;
      octx.moveTo(X - C * 0.35, Y + C * 0.1);
      octx.quadraticCurveTo(X, Y - C * 0.3, X + C * 0.35, Y + C * 0.1);
    }
  }
  octx.strokeStyle = 'rgba(150, 170, 230, 0.6)'; octx.lineWidth = 1.5; octx.lineCap = 'round';
  octx.stroke();
  mapDirty = false;
}

function strokeOutline(pid, color, width) {
  ctx.beginPath();
  const s = cam.s;
  for (let i = 0; i < N; i++) {
    if (owner[i] !== pid) continue;
    const x = tx(i), y = ty(i), X = cam.x + x * s, Y = cam.y + y * s;
    if (x === 0 || owner[i - 1] !== pid) { ctx.moveTo(X, Y); ctx.lineTo(X, Y + s); }
    if (x === W - 1 || owner[i + 1] !== pid) { ctx.moveTo(X + s, Y); ctx.lineTo(X + s, Y + s); }
    if (y === 0 || owner[i - W] !== pid) { ctx.moveTo(X, Y); ctx.lineTo(X + s, Y); }
    if (y === H - 1 || owner[i + W] !== pid) { ctx.moveTo(X, Y + s); ctx.lineTo(X + s, Y + s); }
  }
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineCap = 'round';
  ctx.stroke();
}
// 白フチ文字
function outlined(text, x, y, size, fill = '#2b2b2b') {
  ctx.font = `800 ${size}px "M PLUS Rounded 1c", sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
  ctx.lineWidth = Math.max(3, size * 0.3); ctx.strokeStyle = '#fff';
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}
function shieldPath(X, Y, w) {
  ctx.moveTo(X - w / 2, Y - w * 0.45);
  ctx.quadraticCurveTo(X, Y - w * 0.6, X + w / 2, Y - w * 0.45);
  ctx.lineTo(X + w / 2, Y);
  ctx.quadraticCurveTo(X + w / 2, Y + w * 0.4, X, Y + w * 0.6);
  ctx.quadraticCurveTo(X - w / 2, Y + w * 0.4, X - w / 2, Y);
  ctx.closePath();
}
function pop(i, color) { effects.push({ kind: 'cell', x: tx(i), y: ty(i), start: performance.now(), dur: 900, color }); }

function render(now) {
  const dpr = window.devicePixelRatio || 1;
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
    canvas.width = Math.round(cw * dpr); canvas.height = Math.round(ch * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (mapDirty) renderMap();
  ctx.fillStyle = '#3d4f93';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  if (shake > 0.3) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.9; }
  ctx.imageSmoothingEnabled = cam.s < C;
  ctx.drawImage(off, cam.x, cam.y, W * cam.s, H * cam.s);
  const s = cam.s;
  const T = (x, y) => [cam.x + x * s, cam.y + y * s];

  // 自国の輪郭（光る縁取り）
  if (players[me].tiles) {
    strokeOutline(me, 'rgba(255, 214, 140, 0.9)', Math.max(4, s * 0.35));
    strokeOutline(me, '#fffaf0', Math.max(2, s * 0.14));
  }

  // 取れるマスのヒント（自分の番のとき、となりのマスに点）
  if (state === 'play' && !mode && players[me].actions > 0) {
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      if (!terrain[i] || owner[i] === me || fallout[i] || !adjacentTo(i, me)) continue;
      const [X, Y] = T(tx(i) + 0.5, ty(i) + 0.5);
      ctx.moveTo(X + s * 0.1, Y); ctx.arc(X, Y, s * 0.1, 0, Math.PI * 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
    ctx.strokeStyle = 'rgba(60,40,140,0.6)'; ctx.lineWidth = 1; ctx.stroke();
  }

  // 盾（守ったマス）
  ctx.beginPath();
  for (let i = 0; i < N; i++) if (shield[i] && owner[i] >= 0) shieldPath(cam.x + (tx(i) + 0.5) * s, cam.y + (ty(i) + 0.5) * s, s * 0.55);
  ctx.fillStyle = '#fffdf5'; ctx.fill();
  ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(1, s * 0.07); ctx.stroke();

  // 汚染マーク
  if (s >= 10) {
    ctx.font = `${s * 0.5}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(40,60,0,0.7)';
    for (let i = 0; i < N; i++) if (fallout[i] && terrain[i]) ctx.fillText('☢', cam.x + (tx(i) + 0.5) * s, cam.y + (ty(i) + 0.5) * s);
  }

  // ホバー・選択中のマス
  if (hoverTile >= 0 && state === 'play') {
    const [X, Y] = T(tx(hoverTile), ty(hoverTile));
    ctx.strokeStyle = 'rgba(34,34,34,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(X + 1, Y + 1, s - 2, s - 2);
  }
  if (selTile >= 0) {
    const [X, Y] = T(tx(selTile), ty(selTile));
    const pulse = 0.5 + 0.5 * Math.sin(now / 180);
    ctx.strokeStyle = '#222'; ctx.lineWidth = 5; ctx.strokeRect(X - 1, Y - 1, s + 2, s + 2);
    ctx.strokeStyle = `rgba(255, 215, 80, ${0.7 + 0.3 * pulse})`; ctx.lineWidth = 3; ctx.strokeRect(X - 1, Y - 1, s + 2, s + 2);
  }

  // 核モード：迎撃範囲と爆発範囲
  if (mode && NUKE[mode]) {
    for (const b of bAt.values()) {
      if (b.type !== 'sam' || b.owner === me) continue;
      const [X, Y] = T(b.x + 0.5, b.y + 0.5);
      ctx.beginPath(); ctx.arc(X, Y, SAM_RANGE * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(80,140,255,0.12)'; ctx.fill();
      ctx.strokeStyle = 'rgba(40,90,200,0.7)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
    if (hoverTile >= 0) {
      const [X, Y] = T(tx(hoverTile) + 0.5, ty(hoverTile) + 0.5);
      ctx.beginPath(); ctx.arc(X, Y, (NUKE[mode].r + 0.5) * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(217,64,43,0.2)'; ctx.fill();
      ctx.strokeStyle = '#d9402b'; ctx.lineWidth = 3; ctx.stroke();
    }
  }
  if (mode && BUILD[mode] && hoverTile >= 0) {
    const [X, Y] = T(tx(hoverTile), ty(hoverTile));
    ctx.fillStyle = canPlace(players[me], hoverTile) ? 'rgba(220,60,60,0.5)' : 'rgba(80,200,80,0.6)';
    ctx.fillRect(X, Y, s, s);
    if (mode === 'sam') {
      ctx.beginPath(); ctx.arc(X + s / 2, Y + s / 2, SAM_RANGE * s, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(40,90,200,0.7)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
    }
  }

  // 最高峰
  if (peak >= 0 && !bAt.has(peak)) {
    const [X, Y] = T(tx(peak) + 0.5, ty(peak) + 0.5), m = Math.min(24, Math.max(10, s * 0.75));
    ctx.beginPath(); ctx.moveTo(X - m, Y + m * 0.5); ctx.lineTo(X, Y - m * 0.6); ctx.lineTo(X + m, Y + m * 0.5); ctx.closePath();
    ctx.fillStyle = '#4a5a9a'; ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X - m * 0.38, Y - m * 0.18); ctx.lineTo(X, Y - m * 0.6); ctx.lineTo(X + m * 0.38, Y - m * 0.18); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    if (showLabels) outlined('大山', X, Y + m * 0.95, Math.max(10, Math.min(14, s * 0.55)));
  }

  // 首都の旗
  for (const p of players) {
    if (!p.alive || p.capital < 0 || owner[p.capital] !== p.id) continue;
    const [X, Y] = T(tx(p.capital) + 0.5, ty(p.capital) + 0.65), h = Math.min(30, Math.max(14, s * 0.9));
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(X, Y - h);
    ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(2, h * 0.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X, Y - h); ctx.lineTo(X + h * 0.6, Y - h * 0.78); ctx.lineTo(X, Y - h * 0.56); ctx.closePath();
    ctx.fillStyle = '#fffdf5'; ctx.fill(); ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.arc(X + h * 0.2, Y - h * 0.78, h * 0.08, 0, Math.PI * 2); ctx.fillStyle = p.color; ctx.fill();
    ctx.beginPath(); ctx.arc(X, Y, h * 0.12, 0, Math.PI * 2); ctx.fillStyle = '#222'; ctx.fill();
  }

  // 建物（丸バッジ）
  const bs = Math.min(30, Math.max(13, s * 0.85));
  for (const b of bAt.values()) {
    const [X, Y] = T(b.x + 0.5, b.y + 0.5);
    ctx.beginPath(); ctx.arc(X, Y, bs / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#fffdf5'; ctx.fill();
    ctx.strokeStyle = players[b.owner].color; ctx.lineWidth = 3; ctx.stroke();
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.font = `${bs * 0.55}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#222';
    ctx.fillText(BUILD[b.type].icon, X, Y + bs * 0.02);
    if (b.cd > 0) {
      ctx.beginPath(); ctx.arc(X, Y, bs * 0.62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - b.cd / (b.type === 'silo' ? SILO_RELOAD : SAM_RELOAD)));
      ctx.strokeStyle = '#d9402b'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }

  // 国名ラベル（大きい国から順に、重なるものは省略。自国は必ず表示）
  const placed = [];
  const order = players.filter((p) => p.alive && p.tiles).sort((a, b) => (b.id === me) - (a.id === me) || b.tiles - a.tiles);
  for (const p of showLabels ? order : []) {
    const size = Math.min(32, Math.max(11, Math.sqrt(p.tiles) * s * 0.32));
    const [X, Y] = T(p.lx, p.ly);
    ctx.font = `800 ${size}px "M PLUS Rounded 1c", sans-serif`;
    const bw = ctx.measureText(p.name).width / 2 + 4, box = [X - bw, Y - size * 1.1, X + bw, Y + size * 1.1];
    if (p.id !== me && placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
    placed.push(box);
    outlined(p.name, X, Y - size * 0.3, size);
    outlined(`${p.tiles}マス`, X, Y + size * 0.62, Math.max(9, size * 0.42), '#555');
  }
  // 町の名前（ズームしたら、国名と重ならないものだけ）
  if (showLabels && s >= 22) {
    const fs = Math.min(14, s * 0.4);
    for (const pv of provinces) {
      if (!pv.land) continue;
      const [X, Y] = T(pv.lx, pv.ly);
      if (X < -50 || Y < -20 || X > cw + 50 || Y > ch + 20) continue;
      ctx.font = `800 ${fs}px "M PLUS Rounded 1c", sans-serif`;
      const bw = ctx.measureText(pv.name).width / 2 + 4, box = [X - bw, Y - fs, X + bw, Y + fs];
      if (placed.some((q) => box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1])) continue;
      placed.push(box);
      outlined(pv.name, X, Y, fs, '#555');
    }
  }

  // ミサイル
  for (const m of missiles) {
    const f = Math.min(1, (now - m.start) / m.dur);
    if (f < 0) continue;
    const [TX, TY] = T(m.tx + 0.5, m.ty + 0.5);
    const r = ((m.type === 'warhead' ? WARHEAD_R : m.type === 'mirv' ? 3 : NUKE[m.type].r) + 0.5) * s;
    ctx.beginPath(); ctx.arc(TX, TY, r * (0.9 + 0.1 * Math.sin(now / 120)), 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(217,64,43,0.9)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath();
    for (let k = 0; k <= 20; k++) {
      const p = missilePos(m, f * k / 20), [X, Y] = T(p.x + 0.5, p.y + 0.5);
      k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 3; ctx.stroke();
    const p = missilePos(m, f), [X, Y] = T(p.x + 0.5, p.y + 0.5);
    ctx.beginPath(); ctx.arc(X, Y, m.type === 'warhead' ? 4 : 6, 0, Math.PI * 2);
    ctx.fillStyle = m.type === 'hydro' ? '#ff3b6b' : m.type === 'mirv' || m.type === 'warhead' ? '#b04cff' : '#ff8a00';
    ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.stroke();
    if (m.intercept > 0 && f > m.intercept - 0.3) {    // 迎撃ミサイル
      const g = Math.min(1, (f - (m.intercept - 0.3)) / 0.3);
      const [SX, SY] = T(m.samX + 0.5, m.samY + 0.5);
      ctx.beginPath(); ctx.moveTo(SX, SY); ctx.lineTo(SX + (X - SX) * g, SY + (Y - SY) * g);
      ctx.strokeStyle = '#2f6bff'; ctx.lineWidth = 2.5; ctx.stroke();
    }
  }

  // エフェクト
  effects = effects.filter((e) => now - e.start < e.dur);
  for (const e of effects) {
    const t = (now - e.start) / e.dur;
    if (t < 0) continue;
    const [X, Y] = T(e.x + 0.5, e.y + 0.5);
    if (e.kind === 'boom') {
      const R = (e.r + 0.5) * s * (0.4 + t * 1.2);
      const grad = ctx.createRadialGradient(X, Y, 0, X, Y, R);
      grad.addColorStop(0, `rgba(255,255,230,${1 - t})`);
      grad.addColorStop(0.4, `rgba(255,170,40,${0.9 * (1 - t)})`);
      grad.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(X, Y, (e.r + 0.5) * s * (0.5 + t * 2), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - t)})`; ctx.lineWidth = 4 * (1 - t) + 1; ctx.stroke();
    } else if (e.kind === 'cell') {
      const R = s * (0.5 + t * 0.8);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = e.color; ctx.lineWidth = 4; ctx.strokeRect(X - R, Y - R, R * 2, R * 2);
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.strokeRect(X - R - 2, Y - R - 2, R * 2 + 4, R * 2 + 4);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 1 - t;
      ctx.beginPath(); ctx.arc(X, Y, 4 + t * s, 0, Math.PI * 2);
      ctx.strokeStyle = e.color; ctx.lineWidth = 3; ctx.stroke();
      ctx.globalAlpha = 1;
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
    x0 = Math.min(x0, tx(i)); x1 = Math.max(x1, tx(i)); y0 = Math.min(y0, ty(i)); y1 = Math.max(y1, ty(i));
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min((c.width - 8) / bw, (c.height - 8) / bh, 14);
  const ox = (c.width - bw * k) / 2, oy = (c.height - bh * k) / 2;
  for (let pass = 0; pass < 2; pass++) {
    g.fillStyle = pass ? P.color : '#222';
    const o = pass ? 0 : 1.5;
    for (let i = 0; i < N; i++) if (owner[i] === me) {
      g.fillRect(ox + (tx(i) - x0) * k - o, oy + (ty(i) - y0) * k - o, k + o * 2 + 0.5, k + o * 2 + 0.5);
    }
  }
}

// ===== カメラ =====
function fitCamera() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const ui = !$('infoCard').classList.contains('hidden');
  const top = ui ? $('infoCard').getBoundingClientRect().bottom + 12 : 40;
  const bottom = ui ? ch - $('actionBar').getBoundingClientRect().top + 8 : 40;
  const side = ui && cw < 700 ? 64 : 16;
  cam.s = Math.min((cw - side * 2) / W, (ch - top - bottom) / H);
  cam.x = (cw - W * cam.s) / 2;
  cam.y = top + (ch - top - bottom - H * cam.s) / 2;
}
function zoomAt(sx, sy, ns) {
  const minS = Math.min(canvas.clientWidth / W, canvas.clientHeight / H) * 0.5;
  ns = Math.max(minS, Math.min(90, ns));
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
  if (e.pointerType === 'mouse') hoverTile = screenToTile(e.clientX, e.clientY);
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch.s * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d);
  } else if (drag) {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved && Math.hypot(dx, dy) > 8) { drag.moved = true; drag.cx = cam.x - dx; drag.cy = cam.y - dy; }
    if (drag.moved && !pinch) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; }
  }
});
function endPointer(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (drag && !drag.moved && pointers.size === 0 && e.type === 'pointerup') handleClick(e.clientX, e.clientY, e.button);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) drag = null;
  else if (drag) drag.moved = true;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', () => { hoverTile = -1; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(e.clientX, e.clientY, cam.s * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); }, { passive: false });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

function handleClick(sx, sy, button) {
  const t = screenToTile(sx, sy);
  if (state === 'spawn') {
    if (t >= 0 && terrain[t]) startGame(t);
    else toast('陸地を選んでね');
    return;
  }
  if (state !== 'play') return;
  if (button === 2) { setMode(null); hideSel(); return; }
  if (t < 0) { hideSel(); return; }
  const P = players[me];
  if (mode && BUILD[mode]) {
    const err = placeBuilding(P, mode, t);
    if (err) toast(err); else { setMode(null); updateUI(); }
    return;
  }
  if (mode && NUKE[mode]) {
    const err = launchNuke(P, mode, t);
    if (err) toast(err);
    setMode(null);
    updateUI();
    return;
  }
  if (t === selTile && !$('selGo').disabled) { doPlayerAction(t); return; }   // 2回タップで決定
  showSel(t);
}

// 選んだマスのポップアップ
function showSel(i) {
  selTile = i;
  const P = players[me], o = terrain[i] ? owner[i] : -2;
  const go = $('selGo');
  let title, sub = '', action = null;
  if (o === -2) { title = '海'; sub = '海は取れません'; }
  else {
    const who = o === me ? '自分' : o >= 0 ? players[o].name : '無人';
    title = `${town(i)}のマス`;
    sub = `${who}${shield[i] ? '・🛡守り中' : ''}${fallout[i] ? `・☢汚染 あと${fallout[i]}日` : ''}${bAt.has(i) ? '・' + BUILD[bAt.get(i).type].name : ''}`;
    if (o === me) { action = shield[i] ? null : '守る'; if (shield[i]) sub += '（もう守っています）'; }
    else {
      const err = canTake(P, i);
      if (err) sub += `（${err}）`;
      else action = o >= 0 && shield[i] ? '盾をこわす' : '取る！';
    }
  }
  if (P.actions <= 0) { action = null; sub += '（今日はもう動けません）'; }
  $('selTitle').textContent = title;
  $('selSub').textContent = sub;
  go.textContent = action || '—';
  go.disabled = !action;
  go.classList.toggle('guard', action === '守る');
  $('selPop').classList.remove('hidden');
}
function hideSel() { selTile = -1; $('selPop').classList.add('hidden'); }
$('selGo').addEventListener('click', () => { if (selTile >= 0) doPlayerAction(selTile); });
$('selCancel').addEventListener('click', hideSel);

window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { setMode(null); hideSel(); }
  else if (e.key === 'Enter' && selTile >= 0 && !$('selGo').disabled) doPlayerAction(selTile);
  else if ((e.key === 'n' || e.key === 'N') && state === 'play') passDay();
  else if (state === 'play') {
    for (const [k, v] of Object.entries({ ...BUILD, ...NUKE })) if (v.key === e.key) setMode(mode === k ? null : k);
  }
});

function passDay() {
  if (state !== 'play') return;
  hideSel();
  setMode(null);
  if (players[me].actions > 0) log(`${players[me].name}は今日の1マスを使わずに休んだ`, me);
  players[me].actions = 0;
  state = 'busy';
  updateUI();
  setTimeout(advanceDay, 300);
}

function setMode(m) {
  mode = m;
  if (m) hideSel();
  document.querySelectorAll('.bbtn').forEach((b) => b.classList.toggle('active', b.dataset.type === m));
  if (!m) setHint(null);
  else if (BUILD[m]) setHint(`${BUILD[m].icon} ${BUILD[m].name}を建てる自分のマスをタップ`, true);
  else setHint(`${NUKE[m].icon} ${NUKE[m].name}の目標をタップ`, true);
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

let sheetTab = null;
function updateUI() {
  const P = players[me];
  $('cName').textContent = P.name;
  $('cSwatch').style.background = P.color;
  $('cSub').textContent = '・' + diff.label;
  const rank = ranking().indexOf(P) + 1;
  $('cRank').textContent = P.alive ? `${rank}位` : '滅亡';
  $('cTiles').textContent = P.tiles;
  $('cTilesShort').textContent = P.tiles + 'マス';
  const d = P.tiles - yesterdayTiles;
  $('cDelta').textContent = '前日比 ' + (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);
  $('cGold').textContent = fmt(P.gold);
  $('cIncome').textContent = goldRate(P);
  $('cShields').textContent = shieldCount(P);
  $('cCities').textContent = P.cnt.city;
  $('cLeft').textContent = Math.max(0, SEASON_DAYS - day + 1);
  $('dDay').textContent = Math.min(day, SEASON_DAYS);
  $('dLeft').innerHTML = state === 'spawn' ? 'スタート地点をえらぶ'
    : state === 'busy' ? 'ほかの国が動いています…'
    : `今日の1マス：のこり <b>${P.actions}</b>`;
  $('btnPass').disabled = state !== 'play';
  const incoming = missiles.some((m) => m.owner !== me && (m.victim === me || (m.type === 'warhead' && owner[m.ty * W + m.tx] === me)));
  $('nukeAlert').classList.toggle('hidden', !incoming);

  for (const b of document.querySelectorAll('.bbtn')) {
    const k = b.dataset.type;
    const cost = BUILD[k] ? buildCost(P, k) : NUKE[k].cost;
    b.querySelector('.cs').textContent = '💰' + fmt(cost);
    b.disabled = state !== 'play' || P.gold < cost || (NUKE[k] && !P.cnt.silo);
  }
  drawSilhouette();
  if (sheetTab === 'rank') renderRank();
  if (sheetTab === 'recent') renderRecent();
}

function renderRank() {
  $('sheet').innerHTML = '<h3>順位</h3>' + ranking().map((p, k) => `
    <div class="rk ${p.id === me ? 'me' : ''} ${p.alive ? '' : 'dead'}">
      <span class="no">${p.alive ? k + 1 + '位' : '—'}</span>
      <span class="sw" style="background:${p.color}"></span>
      <span class="nm">${esc(p.name)}</span>
      <span class="v">${p.tiles}マス</span>
      <span class="v">💰${fmt(p.gold)}</span>
      <span class="v">${(p.tiles / landCount * 100).toFixed(1)}%</span>
    </div>`).join('');
}
function renderRecent() {
  $('sheet').innerHTML = '<h3>最近のできごと</h3>' + (logs.length ? logs.slice().reverse().slice(0, 60).map((l) => `
    <div class="lg ${l.cls}"><span class="sw" style="background:${l.color}"></span>${esc(l.text)}<span class="ago">${agoText(l.day)}</span></div>`).join('') : '<p>まだ何も起きていません</p>');
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const agoText = (d) => (d === day ? '今日' : d === day - 1 ? '昨日' : `${day - d}日前`);

function log(text, pid, cls = '') {
  const color = pid != null && players[pid] ? players[pid].color : '#ccc';
  logs.push({ text, color, cls, day });
  if (logs.length > 200) logs.shift();
  ticker(text, color, '今日');
}
function ticker(text, color, ago = 'いま') {
  $('ticker').querySelector('.tx').textContent = text;
  $('ticker').querySelector('.sw').style.background = color || '#ccc';
  $('ticker').querySelector('.ago').textContent = ago;
}

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

$('btnPass').addEventListener('click', passDay);
$('btnStart').addEventListener('click', newGame);
$('btnRestart').addEventListener('click', () => {
  $('endCard').classList.add('hidden');
  $('menu').classList.remove('hidden');
});
$('btnWatch').addEventListener('click', () => { $('overlay').classList.add('hidden'); });
$('btnZoomIn').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s * 1.3));
$('btnZoomOut').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s / 1.3));
$('btnHome').addEventListener('click', () => { const P = players[me]; if (P.tiles) centerOn(P.lx, P.ly, Math.max(cam.s, 26)); });
$('btnCollapse').addEventListener('click', () => {
  const c = $('infoCard').classList.toggle('collapsed');
  $('btnCollapse').textContent = c ? '▼' : '▲';
});
$('btnLabels').addEventListener('click', () => {
  showLabels = !showLabels;
  $('btnLabels').classList.toggle('off', !showLabels);
});
window.addEventListener('resize', () => { if (state === 'menu' || state === 'spawn') fitCamera(); });

// タイトル画面の背景用にマップを生成しておく
setDims();
genMap((Math.random() * 1e9) | 0);
owner = new Int16Array(N).fill(-1);
shield = new Uint8Array(N);
fallout = new Uint8Array(N);
bAt = new Map(); missiles = []; effects = []; logs = [];
players = [makePlayer(0, '', ME_COLOR, false)];
fitCamera();
requestAnimationFrame(frame);

// テスト・デバッグ用
window.__jintori = {
  get players() { return players; }, get state() { return state; }, set state(v) { state = v; }, get day() { return day; },
  get missiles() { return missiles; }, get landCount() { return landCount; },
  flushMissiles() { for (let k = 0; k < 3; k++) updateMissiles(performance.now() + 1e7 * (k + 1)); },
  owner: () => owner, shield: () => shield, launchNuke, placeBuilding, doPlayerAction, advanceDay, botAct, canTake,
};
})();
