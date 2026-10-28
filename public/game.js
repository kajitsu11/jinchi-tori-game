'use strict';
(() => {
// ===== 定数 =====
let W = 440, H = 560, N = W * H;      // 1万人規模のマップ（約25万マス、陸地は約14万マス）。オンライン版と同じ大きさ
const SEASON_DAYS = 100;
const WIN_SHARE = 0.6;
const SAM_RANGE = 12;
const SILO_RELOAD = 2;                // 日
const SAM_RELOAD = 3;                 // 日
const ACTIVE_RATE = 0.55;             // CPU対戦：1日に行動する住民の割合
const NO_GUARD_R = 4;                 // 大山のまわりの「守れない」範囲（マス）

const BUILD = {
  city: { name: '都市',        icon: '🏙', base: 50,  scale: 1.0, key: '1' },
  silo: { name: 'ミサイル基地', icon: '🚀', base: 120, scale: 1.0, key: '2' },
  sam:  { name: '迎撃基地',    icon: '🛡', base: 80,  scale: 0.6, key: '3' },
};
const NUKE = {
  atom:  { name: '原子爆弾', icon: '☢', cost: 150, r: 4,  fallout: 3, key: '4' },
  hydro: { name: '水素爆弾', icon: '💥', cost: 400, r: 9,  fallout: 5, key: '5' },
  mirv:  { name: 'MIRV',    icon: '🎆', cost: 900, r: 14, fallout: 3, key: '6', warheads: 6 },
};
const WARHEAD_R = 3;

// power：CPUの国の住民がどれくらい動くか（あなたの国は 1）
const DIFF = {
  easy:   { label: 'かんたん',  power: 0.85, hateMe: 0.03,  nukeStart: 25, nukeRate: 0.05, defend: 0.15 },
  normal: { label: 'ふつう',    power: 1.0,  hateMe: 0.1, nukeStart: 18, nukeRate: 0.1,  defend: 0.2 },
  hard:   { label: 'むずかしい', power: 1.15, hateMe: 0.25,  nukeStart: 12, nukeRate: 0.16, defend: 0.25 },
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
let plainView = false;                // 「国で見る」：マスの記号を消して色だけにする
let prevOwner = null, savedOwner = null;   // 前日の勢力図
let online = null;   // オンライン対戦中は { token, me, costs, nukeCosts, ... }
const cam = { x: 0, y: 0, s: 16 };

const $ = (id) => document.getElementById(id);
const canvas = $('game'), ctx = canvas.getContext('2d');
const off = document.createElement('canvas');
const octx = off.getContext('2d');
let img, pix;
function setDims(w, h) {
  [W, H] = w ? [w, h] : [440, 560];
  N = W * H;
  off.width = W; off.height = H;   // 1マス＝1ピクセル
  img = octx.createImageData(W, H);
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

// ===== マップ生成（shared/map.js と共通。サーバーも同じ seed から同じマップを作る） =====
function genMap(seed) {
  const m = window.JintoriMap.generate(seed, W, H);
  ({ terrain, elev, prov, provinces, peak, landCount } = m);
  baseRGB = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    let c;
    if (!terrain[i]) { const d = elev[i]; c = [72 - d * 18, 90 - d * 22, 170 - d * 30]; }
    else if (elev[i] > 0.7) c = [226, 214, 186];   // 山地
    else { const e = elev[i]; c = [246 - e * 12, 240 - e * 10, 222 - e * 18]; }
    baseRGB.set(c.map(Math.round), i * 3);
  }
}

// ===== プレイヤー =====
function makePlayer(id, name, color, isBot) {
  return {
    id, name, abbr: [...name].slice(0, 2).join(''), color, rgb: hex2rgb(color), isBot, alive: true,
    gold: 30, treasury: 0, members: 0, tiles: 0, cnt: { city: 0, silo: 0, sam: 0 }, actions: 1, capital: -1,
    nb: new Set(), lx: 0, ly: 0, grudge: -1,
  };
}
const playerIncome = (p) => 10 + p.cnt.city * 3;   // あなたが1マス動くたびにもらえる金
const buildCost = (p, type) => (online ? online.costs[p.id][type] : Math.round(BUILD[type].base * (1 + BUILD[type].scale * p.cnt[type])));
const nukeCost = (type) => (online ? online.nukeCosts[type] : NUKE[type].cost);
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
  markCell(i);
}

// ===== ゲーム開始 =====
function newGame() {
  const nBots = parseInt($('optBots').value, 10);
  const pop = parseInt($('optPop').value, 10);
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
  for (const p of players) p.members = Math.max(1, Math.round(pop / players.length));   // あなたの国の人数にはあなたも入る
  me = 0; day = 1; mode = null; selTile = -1;
  prevOwner = null; savedOwner = null;
  state = 'spawn';
  mapDirty = true;
  $('overlay').classList.add('hidden');
  $('endCard').classList.add('hidden');
  ['infoCard', 'sideBtns', 'bottom'].forEach((id) => $(id).classList.remove('hidden'));
  closeSheet();
  hideSel();
  fitCamera();
  setHint('🏁 あなたの国のスタート地点をタップしてね');
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
    for (let tries = 0; tries < 20000 && !placed; tries++) {
      if (tries % 500 === 499) minD *= 0.85;
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
  log(`${players[me].name} が ${town(spawnTile)} に建国しました！（仲間 ${players[me].members.toLocaleString()}人）`, me, 'good');
  centerOn(tx(spawnTile) + 0.5, ty(spawnTile) + 0.5, Math.max(cam.s, 6));
  updateUI();
}

// ===== 1日の行動 =====
const adjacentTo = (i, pid) => neighbors(i).some((j) => owner[j] === pid);
const noGuard = (i) => peak >= 0 && Math.hypot(tx(i) - tx(peak), ty(i) - ty(peak)) <= NO_GUARD_R;
function canTake(p, i) {
  if (i < 0 || !terrain[i]) return '海は取れません';
  if (owner[i] === p.id) return '自分のマスです';
  if (fallout[i] > 0) return `放射能汚染中（あと${fallout[i]}日）`;
  if (online && !p.tiles) return owner[i] >= 0 ? '国がなくなったときは、無人のマスから建て直せます' : null;
  if (!adjacentTo(i, p.id)) return '自分の陣地のとなりのマスしか取れません';
  return null;
}
// あなたが取る。盾があれば盾がこわれるだけ
function takeTile(p, i) {
  const o = owner[i];
  if (o >= 0 && shield[i]) {
    shield[i] = 0;
    markCell(i);
    pop(i, '#ffffff');
    log(`${players[o].name}が ${town(i)} を守った（${p.name}の攻撃）`, o, 'warn');
    return 'blocked';
  }
  setOwner(i, p.id);
  pop(i, p.color);
  log(`${p.name}が ${o >= 0 ? players[o].name + 'の ' : ''}${town(i)} を取った`, p.id, 'good');
  if (o >= 0 && players[o].isBot) players[o].grudge = p.id;
  return 'took';
}
function guardTile(p, i) {
  shield[i] = 1;
  markCell(i);
  pop(i, '#ffffff');
  log(`${p.name}が ${town(i)} を守った`, p.id, 'good');
}

// プレイヤーの1マス
function doPlayerAction(i) {
  const P = players[me];
  if (state !== 'play' || P.actions <= 0) return;
  if (online) { onlineSend('/api/act', { cell: i, kind: owner[i] === me ? 'guard' : 'take' }); hideSel(); return; }
  if (owner[i] === me) {
    if (shield[i]) { toast('もう守っています'); return; }
    if (noGuard(i)) { toast('大山のまわりは守れません'); return; }
    guardTile(P, i);
  } else {
    const err = canTake(P, i);
    if (err) { toast(err); return; }
    takeTile(P, i);
  }
  P.actions--;
  P.gold += playerIncome(P);
  hideSel();
  scan();
  updateUI();
  if (P.actions <= 0 && state === 'play') {
    state = 'busy';
    updateUI();
    setTimeout(advanceDay, 400);
  }
}

// 1日を進める：各国の住民（CPU）がそれぞれ1マスずつ動き、金が入り、汚染が薄れる
function advanceDay() {
  if (state !== 'busy') return;
  prevOwner = owner.slice();
  const F = buildFrontiers();
  const stats = players.map(() => ({ done: 0, gained: 0, lostTo: new Map() }));
  // その日に動く人数（あなたの国は、あなたを除いた仲間の分）
  const quota = players.map((p) => {
    if (!p.alive || !p.tiles) return 0;
    const mul = p.id === me ? 1 : diff.power;
    const n = Math.round(p.members * ACTIVE_RATE * mul * (0.9 + Math.random() * 0.2));
    return Math.max(0, n - (p.id === me ? 1 : 0));
  });
  // 先に動いた国が得をしないよう、少しずつ順番に動かす
  for (let left = true; left;) {
    left = false;
    for (const p of shuffle(players.filter((q) => quota[q.id] > 0))) {
      const n = Math.min(quota[p.id], 40);
      for (let k = 0; k < n; k++) aiAct(p, F, stats);
      quota[p.id] -= n;
      if (quota[p.id] > 0) left = true;
    }
  }
  // 1日のまとめ
  const P = players[me], st = stats[me];
  let lost = 0, worst = -1, worstN = 0;
  for (const [o, c] of st.lostTo) { lost += c; if (c > worstN) { worstN = c; worst = o; } }
  if (P.tiles) log(`${day}日目：${P.name}は仲間と +${st.gained.toLocaleString()}マス / −${lost.toLocaleString()}マス`, me, st.gained >= lost ? 'good' : 'warn');
  if (worst >= 0 && worstN >= 5) log(`${players[worst].name}に ${worstN.toLocaleString()}マス取られた！`, worst, 'warn');
  players.forEach((p, k) => {   // いちばん多く取ってきた国を恨む（あなたの国の仲間も）
    let wo = -1, wn = 0;
    for (const [o, c] of stats[k].lostTo) if (c > wn) { wn = c; wo = o; }
    if (wo >= 0 && wn >= 10) p.grudge = wo;
  });
  // お金・建設・核（各国の金庫から。あなたの国の金庫は仲間が使う）
  players.forEach((p, k) => {
    if (!p.alive) return;
    p.treasury += stats[p.id].done * 2 + p.cnt.city * 20;
    nationEconomy(p, k);
  });
  day++;
  P.actions = 1;
  for (let i = 0; i < N; i++) if (fallout[i] > 0) { fallout[i]--; markCell(i); }
  for (const b of bAt.values()) if (b.cd > 0) b.cd--;
  yesterdayTiles = P.tiles;
  scan();
  state = 'play';
  checkEnd();
  updateUI();
}

// ===== CPU（住民）の動き =====
// 1日のはじめに、各国が「取れる無人のマス」「取れる敵のマス」「守るべきマス」の候補を作る。
// 動くたびに候補を足していき、使えなくなった候補は選ばれたときに捨てる（毎回マップ全体を調べないため）
function buildFrontiers() {
  const F = players.map(() => ({ neutral: [], enemy: [], guard: [] }));
  for (let i = 0; i < N; i++) {
    if (!terrain[i]) continue;
    const o = owner[i], x = i % W, y = (i / W) | 0;
    let a = -2, b = -2, threatened = false;
    for (let d = 0; d < 4; d++) {
      const j = d === 0 ? (x > 0 ? i - 1 : -1) : d === 1 ? (x < W - 1 ? i + 1 : -1) : d === 2 ? (y > 0 ? i - W : -1) : (y < H - 1 ? i + W : -1);
      if (j < 0 || !terrain[j]) continue;
      const q = owner[j];
      if (q < 0 || q === o || q === a || q === b) continue;
      if (a === -2) a = q; else b = q;
      if (o < 0) { if (!fallout[i]) F[q].neutral.push(i); }
      else { F[q].enemy.push(i); threatened = true; }
    }
    if (o >= 0 && threatened && !shield[i]) F[o].guard.push(i);
  }
  return F;
}
// 候補から有効なものを1つ選ぶ（となりの自分のマスが多い方を優先して、まとまって広がる）
function pickFrom(list, valid, score) {
  let best = -1, bs = -1;
  for (let tries = 0; tries < 3 && list.length;) {
    const k = Math.floor(Math.random() * list.length), i = list[k];
    if (!valid(i)) { list[k] = list[list.length - 1]; list.pop(); continue; }
    const s = score(i) + Math.random();
    if (s > bs) { bs = s; best = i; }
    tries++;
  }
  return best;
}
function aiAct(p, F, stats) {
  const f = F[p.id], id = p.id;
  const ownN = (i) => { let c = 0; for (const j of neighbors(i)) if (owner[j] === id) c++; return c; };
  const takeable = (i) => owner[i] !== id && terrain[i] && !fallout[i] && adjacentTo(i, id);
  stats[id].done++;
  // 守る
  if (f.guard.length && Math.random() < diff.defend * (f.neutral.length ? 0.3 : 1)) {
    const i = pickFrom(f.guard, (i) => owner[i] === id && !shield[i] && !noGuard(i), () => 0);
    if (i >= 0) { shield[i] = 1; return; }
  }
  // 無人のマスを取る（序盤ほど優先）
  if (f.neutral.length && (!f.enemy.length || Math.random() < Math.max(0.35, 0.9 - day / 80))) {
    const i = pickFrom(f.neutral, (i) => owner[i] < 0 && takeable(i), ownN);
    if (i >= 0) { aiTake(p, i, F, stats); return; }
  }
  // 敵のマスを取る（恨みのある国・あなたの国をねらうことも）
  if (f.enemy.length) {
    const want = p.grudge >= 0 && Math.random() < 0.5 ? p.grudge : id !== me && Math.random() < diff.hateMe ? me : -1;
    let i = -1;
    if (want >= 0) i = pickFrom(f.enemy, (i) => owner[i] >= 0 && takeable(i), (i) => (owner[i] === want ? 5 : 0) + ownN(i));
    else i = pickFrom(f.enemy, (i) => owner[i] >= 0 && takeable(i), (i) => ownN(i) - shield[i] * 2);
    if (i >= 0) { aiTake(p, i, F, stats); return; }
  }
  if (f.neutral.length) {
    const i = pickFrom(f.neutral, (i) => owner[i] < 0 && takeable(i), ownN);
    if (i >= 0) aiTake(p, i, F, stats);
  }
}
function aiTake(p, i, F, stats) {
  const o = owner[i];
  if (o >= 0 && shield[i]) { shield[i] = 0; markCell(i); return; }   // 盾がこわれるだけ
  setOwner(i, p.id);
  stats[p.id].gained++;
  if (o >= 0) stats[o].lostTo.set(p.id, (stats[o].lostTo.get(p.id) || 0) + 1);
  // 新しく取ったマスのまわりを候補に足す
  for (const j of neighbors(i)) {
    if (!terrain[j]) continue;
    const q = owner[j];
    if (q < 0) { if (!fallout[j]) F[p.id].neutral.push(j); }
    else if (q !== p.id) { F[p.id].enemy.push(j); F[q].enemy.push(i); F[q].guard.push(j); F[p.id].guard.push(i); }
  }
}

// 国の金庫で建設と核（あなたの国では、仲間が金庫で建てたり撃ったりする）
function randomTileOf(pid, tries = 4000) {
  for (let k = 0; k < tries; k++) { const i = Math.floor(Math.random() * N); if (owner[i] === pid) return i; }
  for (let i = 0; i < N; i++) if (owner[i] === pid) return i;
  return -1;
}
function nationEconomy(p, k) {
  for (let n = 0; n < 10; n++) {
    let type = null;
    if (day > diff.nukeStart * 0.6 && p.cnt.silo < 1 + Math.floor(p.tiles / 2500)) type = 'silo';
    else if (p.cnt.silo && p.cnt.sam < p.cnt.silo) type = 'sam';
    else if (p.cnt.city < 1 + Math.floor(p.tiles / 600)) type = 'city';
    if (!type) break;
    const reserve = p.cnt.silo && type === 'city' ? NUKE.hydro.cost : 0;
    if (p.treasury < buildCost(p, type) + reserve) break;
    let spot = -1;
    for (let t = 0; t < 50 && spot < 0; t++) {
      const i = randomTileOf(p.id, 500);
      if (i >= 0 && !bAt.has(i) && neighbors(i).every((j) => owner[j] === p.id)) spot = i;
    }
    if (spot < 0 || placeBuilding(p, type, spot, 'treasury')) break;
  }
  if (!p.cnt.silo || day < diff.nukeStart) return;
  for (const b of [...bAt.values()]) {
    if (b.owner !== p.id || b.type !== 'silo' || b.cd || Math.random() > diff.nukeRate) continue;
    let nt = null;
    if (p.treasury >= NUKE.mirv.cost && Math.random() < 0.25) nt = 'mirv';
    else if (p.treasury >= NUKE.hydro.cost && Math.random() < 0.5) nt = 'hydro';
    else if (p.treasury >= NUKE.atom.cost) nt = 'atom';
    if (!nt) break;
    const others = players.filter((q) => q.alive && q.id !== p.id && q.tiles > 0);
    if (!others.length) break;
    let t = p.grudge >= 0 && players[p.grudge].alive && players[p.grudge].tiles ? players[p.grudge] : null;
    if (!t) t = p.id !== me && players[me].tiles && Math.random() < diff.hateMe ? players[me] : others.reduce((a, c) => (c.tiles > a.tiles ? c : a));
    if (t.id === p.id) continue;
    const cities = [...bAt.values()].filter((c) => c.owner === t.id);
    const ti = cities.length && Math.random() < 0.5 ? pick(cities).i : randomTileOf(t.id);
    if (ti >= 0) launchNuke(p, nt, ti, k * 300, 'treasury');
  }
}

// ===== 建設 =====
function canPlace(p, i) {
  if (i < 0 || owner[i] !== p.id) return '自分のマスに建ててください';
  if (bAt.has(i)) return 'そのマスにはもう建物があります';
  return null;
}
// purse：'gold'（あなたの金）か 'treasury'（国の金庫）
function placeBuilding(p, type, i, purse = 'gold') {
  const cost = buildCost(p, type);
  if (p[purse] < cost) return '金が足りません';
  const err = canPlace(p, i);
  if (err) return err;
  p[purse] -= cost;
  bAt.set(i, { type, i, x: tx(i), y: ty(i), owner: p.id, cd: 0 });
  p.cnt[type]++;
  if (p.id === me && purse === 'gold') log(`${town(i)} に${BUILD[type].name}を建てた`, me, 'good');
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
function launchNuke(p, type, ti, delay = 0, purse = 'gold') {
  const NK = NUKE[type];
  if (p[purse] < NK.cost) return '金が足りません';
  if (!p.cnt.silo) return 'ミサイル基地がありません';
  const x = tx(ti), y = ty(ti);
  const silo = readySilo(p, x, y);
  if (!silo) return 'ミサイル基地が再装填中です';
  p[purse] -= NK.cost;
  silo.cd = SILO_RELOAD;
  const dist = Math.hypot(x - silo.x, y - silo.y);
  const victim = terrain[ti] ? owner[ti] : -1;
  const m = { type, owner: p.id, sx: silo.x, sy: silo.y, tx: x, ty: y, start: performance.now() + delay, dur: 1100 + Math.min(dist, 60) * 70, victim, intercept: -1 };
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
    if (m.visual) {   // オンライン：結果はサーバーが決めるので、見た目だけ
      if (m.boomR) effects.push({ kind: 'boom', x: m.tx, y: m.ty, r: m.boomR, start: performance.now(), dur: 1500 });
      if (m.boomR) shake = Math.min(18, shake + m.boomR * 5);
      continue;
    }
    if (m.type === 'mirv') spawned.push(...splitMirv(m, now));
    else if (m.type === 'warhead') detonate(m.tx, m.ty, WARHEAD_R, NUKE.mirv.fallout, m.owner);
    else detonate(m.tx, m.ty, NUKE[m.type].r, NUKE[m.type].fallout, m.owner);
  }
  if (missiles.some((m) => m.dead) || spawned.length) {
    missiles = missiles.filter((m) => !m.dead).concat(spawned);
    if (!online) { scan(); checkEnd(); updateUI(); }
  }
}
function splitMirv(m, now) {
  let targets = [];
  if (m.victim >= 0) for (let i = 0; i < N; i++) if (owner[i] === m.victim) targets.push(i);
  targets = shuffle(targets).slice(0, NUKE.mirv.warheads);
  while (targets.length < NUKE.mirv.warheads) {
    const x = Math.round(m.tx + (Math.random() - 0.5) * 40), y = Math.round(m.ty + (Math.random() - 0.5) * 40);
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

// ===== スキャン（隣接関係・マス数・ラベル位置・滅亡） =====
function scan() {
  const P = players.length;
  const sx = new Float64Array(P), sy = new Float64Array(P), cnt = new Int32Array(P);
  for (const p of players) p.nb = new Set();
  for (let i = 0; i < N; i++) {
    const o = owner[i];
    if (o < 0) continue;
    const x = i % W, y = (i / W) | 0, nb = players[o].nb;
    sx[o] += x; sy[o] += y; cnt[o]++;
    if (x > 0 && terrain[i - 1] && owner[i - 1] !== o) nb.add(owner[i - 1]);
    if (x < W - 1 && terrain[i + 1] && owner[i + 1] !== o) nb.add(owner[i + 1]);
    if (y > 0 && terrain[i - W] && owner[i - W] !== o) nb.add(owner[i - W]);
    if (y < H - 1 && terrain[i + W] && owner[i + W] !== o) nb.add(owner[i + W]);
  }
  // ラベルは重心に一番近い自分のマスに置く（内側のマスを優先。凹んだ形でも陣地内に表示される）
  const cx = new Float64Array(P), cy = new Float64Array(P), bd = new Float64Array(P).fill(Infinity), bi = new Int32Array(P).fill(-1);
  for (let o = 0; o < P; o++) if (cnt[o]) { cx[o] = sx[o] / cnt[o]; cy[o] = sy[o] / cnt[o]; }
  for (let i = 0; i < N; i++) {
    const o = owner[i];
    if (o < 0) continue;
    const x = i % W, y = (i / W) | 0;
    const inner = x > 0 && x < W - 1 && y > 0 && y < H - 1 && owner[i - 1] === o && owner[i + 1] === o && owner[i - W] === o && owner[i + W] === o;
    const d = (x - cx[o]) ** 2 + (y - cy[o]) ** 2 + (inner ? 0 : 6);
    if (d < bd[o]) { bd[o] = d; bi[o] = i; }
  }
  for (const p of players) {
    p.tiles = cnt[p.id];
    if (bi[p.id] >= 0) { p.lx = tx(bi[p.id]) + 0.5; p.ly = ty(bi[p.id]) + 0.5; }
  }
  for (const p of players) {
    if (!online && p.alive && p.tiles === 0 && state !== 'spawn' && state !== 'menu') {
      p.alive = false;
      log(p.id === me ? 'あなたの国は滅亡しました…' : `${p.name} が滅亡した！`, p.id, p.id === me ? 'warn' : '');
    }
  }
}

function ranking() { return players.slice().sort((a, b) => (b.alive - a.alive) || (b.tiles - a.tiles)); }
function checkEnd() {
  if (online || (state !== 'play' && state !== 'busy')) return;
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
// 地図は「1マス＝1ピクセル」の画像にしておき、拡大して描く。
// マス目・斜線・町の境界・波・盾などは、画面に見えている範囲のマスだけ上から描く（大きいマップでも軽くするため）
const mix = (a, b, t) => a + (b - a) * t;
function paintCell(i) {
  const o = owner[i];
  let r, g, b;
  if (o >= 0) [r, g, b] = players[o].rgb;
  else { r = baseRGB[i * 3]; g = baseRGB[i * 3 + 1]; b = baseRGB[i * 3 + 2]; }
  if (fallout[i] > 0 && terrain[i]) { const f = Math.min(0.75, 0.3 + fallout[i] * 0.1); r = mix(r, 150, f); g = mix(g, 220, f); b = mix(b, 40, f); }
  const p = i * 4;
  pix[p] = r; pix[p + 1] = g; pix[p + 2] = b; pix[p + 3] = 255;
}
let dirtyRect = null;
function markCell(i) {
  paintCell(i);
  const x = i % W, y = (i / W) | 0;
  if (!dirtyRect) dirtyRect = { x0: x, y0: y, x1: x, y1: y };
  else {
    dirtyRect.x0 = Math.min(dirtyRect.x0, x); dirtyRect.y0 = Math.min(dirtyRect.y0, y);
    dirtyRect.x1 = Math.max(dirtyRect.x1, x); dirtyRect.y1 = Math.max(dirtyRect.y1, y);
  }
}
function renderMap() {
  for (let i = 0; i < N; i++) paintCell(i);
  octx.putImageData(img, 0, 0);
  mapDirty = false;
  dirtyRect = null;
}

// 斜線模様（自分のものになったマスに重ねる）
const stripeTile = document.createElement('canvas');
stripeTile.width = stripeTile.height = 12;
{
  const g = stripeTile.getContext('2d');
  g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1.6;
  g.beginPath();
  for (let k = -12; k <= 24; k += 6) { g.moveTo(k, 12); g.lineTo(k + 12, 0); }
  g.stroke();
}
let stripePattern = null;

function strokeOutline(pid, color, width, v) {
  ctx.beginPath();
  const s = cam.s;
  for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
    const i = y * W + x;
    if (owner[i] !== pid) continue;
    const X = cam.x + x * s, Y = cam.y + y * s;
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
  else if (dirtyRect) {
    const d = dirtyRect;
    octx.putImageData(img, 0, 0, d.x0, d.y0, d.x1 - d.x0 + 1, d.y1 - d.y0 + 1);
    dirtyRect = null;
  }
  ctx.fillStyle = '#3d4f93';
  ctx.fillRect(0, 0, cw, ch);

  ctx.save();
  if (shake > 0.3) { ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake); shake *= 0.9; }
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, cam.x, cam.y, W * cam.s, H * cam.s);
  const s = cam.s;
  const T = (x, y) => [cam.x + x * s, cam.y + y * s];
  // 画面に見えているマスの範囲
  const v = {
    x0: Math.max(0, Math.floor(-cam.x / s)), x1: Math.min(W - 1, Math.floor((cw - cam.x) / s)),
    y0: Math.max(0, Math.floor(-cam.y / s)), y1: Math.min(H - 1, Math.floor((ch - cam.y) / s)),
  };

  if (s >= 6 && v.x0 <= v.x1 && v.y0 <= v.y1) {
    // 斜線模様
    if (s >= 9 && !plainView) {
      if (!stripePattern) stripePattern = ctx.createPattern(stripeTile, 'repeat');
      stripePattern.setTransform(new DOMMatrix([s / 12, 0, 0, s / 12, cam.x, cam.y]));
      ctx.beginPath();
      for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) if (owner[y * W + x] >= 0) ctx.rect(cam.x + x * s, cam.y + y * s, s, s);
      ctx.fillStyle = stripePattern; ctx.fill();
    }
    // マス目
    ctx.beginPath();
    for (let x = v.x0; x <= v.x1 + 1; x++) { const X = Math.round(cam.x + x * s) + 0.5; ctx.moveTo(X, cam.y + v.y0 * s); ctx.lineTo(X, cam.y + (v.y1 + 1) * s); }
    for (let y = v.y0; y <= v.y1 + 1; y++) { const Y = Math.round(cam.y + y * s) + 0.5; ctx.moveTo(cam.x + v.x0 * s, Y); ctx.lineTo(cam.x + (v.x1 + 1) * s, Y); }
    ctx.strokeStyle = 'rgba(30, 30, 60, 0.13)'; ctx.lineWidth = 1; ctx.stroke();
    // 町の境界線と海の波
    const border = new Path2D(), waves = new Path2D();
    for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
      const i = y * W + x, X = cam.x + x * s, Y = cam.y + y * s;
      if (terrain[i]) {
        if (x < W - 1 && terrain[i + 1] && prov[i + 1] !== prov[i]) { border.moveTo(X + s, Y); border.lineTo(X + s, Y + s); }
        if (y < H - 1 && terrain[i + W] && prov[i + W] !== prov[i]) { border.moveTo(X, Y + s); border.lineTo(X + s, Y + s); }
      } else if (y % 2 === 1 && (x + ((y >> 1) & 1 ? 1 : 0) * 2) % 3 === 0) {
        const cx = X + s / 2, cy = Y + s / 2;
        waves.moveTo(cx - s * 0.35, cy + s * 0.1);
        waves.quadraticCurveTo(cx, cy - s * 0.3, cx + s * 0.35, cy + s * 0.1);
      }
    }
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = Math.max(1.5, s * 0.14); ctx.stroke(border);
    ctx.strokeStyle = 'rgba(150, 170, 230, 0.6)'; ctx.lineWidth = Math.max(1, s * 0.12); ctx.stroke(waves);
  }

  // 自国の輪郭（光る縁取り）
  if (players[me] && players[me].tiles) {
    strokeOutline(me, 'rgba(255, 214, 140, 0.9)', Math.max(3, s * 0.35), v);
    strokeOutline(me, '#fffaf0', Math.max(1.5, s * 0.14), v);
  }

  if (s >= 5) {
    // 取れるマスのヒント（自分の番のとき、となりのマスに点）
    if (state === 'play' && !mode && players[me].actions > 0) {
      ctx.beginPath();
      for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
        const i = y * W + x;
        if (!terrain[i] || owner[i] === me || fallout[i] || !adjacentTo(i, me)) continue;
        const X = cam.x + (x + 0.5) * s, Y = cam.y + (y + 0.5) * s;
        ctx.moveTo(X + s * 0.1, Y); ctx.arc(X, Y, s * 0.1, 0, Math.PI * 2);
      }
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.fill();
      ctx.strokeStyle = 'rgba(60,40,140,0.6)'; ctx.lineWidth = 1; ctx.stroke();
    }
    // マスの記号：守っているマスは盾、ほかは国の名前の頭2文字のバッジ
    if (!plainView) {
      const shields = new Path2D(), badges = [];
      for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
        const i = y * W + x, o = owner[i];
        if (o < 0) continue;
        const X = cam.x + (x + 0.5) * s, Y = cam.y + (y + 0.5) * s;
        if (shield[i]) {
          const w = s * 0.62;
          shields.moveTo(X - w / 2, Y - w * 0.45);
          shields.quadraticCurveTo(X, Y - w * 0.6, X + w / 2, Y - w * 0.45);
          shields.lineTo(X + w / 2, Y);
          shields.quadraticCurveTo(X + w / 2, Y + w * 0.4, X, Y + w * 0.6);
          shields.quadraticCurveTo(X - w / 2, Y + w * 0.4, X - w / 2, Y);
          shields.closePath();
        } else if (s >= 16) badges.push(X, Y, o);
      }
      if (badges.length) {
        const w = s * 0.7, h = s * 0.66, path = new Path2D();
        for (let k = 0; k < badges.length; k += 3) {
          const X = badges[k], Y = badges[k + 1];
          path.moveTo(X - w / 2, Y - h * 0.5); path.lineTo(X + w / 2, Y - h * 0.5); path.lineTo(X + w / 2, Y + h * 0.12);
          path.lineTo(X, Y + h * 0.5); path.lineTo(X - w / 2, Y + h * 0.12); path.closePath();
        }
        ctx.fillStyle = '#fffdf5'; ctx.fill(path);
        ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(1, s * 0.05); ctx.lineJoin = 'round'; ctx.stroke(path);
        ctx.font = `800 ${s * 0.24}px "M PLUS Rounded 1c", sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#2b2b2b';
        for (let k = 0; k < badges.length; k += 3) ctx.fillText(players[badges[k + 2]].abbr, badges[k], badges[k + 1] - h * 0.08);
      }
      ctx.fillStyle = '#fffdf5'; ctx.fill(shields);
      ctx.strokeStyle = '#2b2b2b'; ctx.lineWidth = Math.max(1, s * 0.07); ctx.stroke(shields);
    }
    // 汚染マーク
    if (s >= 10) {
      ctx.font = `${s * 0.5}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = 'rgba(40,60,0,0.7)';
      for (let y = v.y0; y <= v.y1; y++) for (let x = v.x0; x <= v.x1; x++) {
        const i = y * W + x;
        if (fallout[i] && terrain[i]) ctx.fillText('☢', cam.x + (x + 0.5) * s, cam.y + (y + 0.5) * s);
      }
    }
  }

  // ホバー・選択中のマス
  if (hoverTile >= 0 && state === 'play') {
    const [X, Y] = T(tx(hoverTile), ty(hoverTile));
    ctx.strokeStyle = 'rgba(34,34,34,0.6)'; ctx.lineWidth = 2; ctx.strokeRect(X + 1, Y + 1, s - 2, s - 2);
  }
  if (selTile >= 0) {
    const [X, Y] = T(tx(selTile), ty(selTile));
    const pulse = 0.5 + 0.5 * Math.sin(now / 180), e = Math.max(0, 6 - s);   // 小さいときは枠を大きめに
    ctx.strokeStyle = '#222'; ctx.lineWidth = 5; ctx.strokeRect(X - 1 - e, Y - 1 - e, s + 2 + e * 2, s + 2 + e * 2);
    ctx.strokeStyle = `rgba(255, 215, 80, ${0.7 + 0.3 * pulse})`; ctx.lineWidth = 3; ctx.strokeRect(X - 1 - e, Y - 1 - e, s + 2 + e * 2, s + 2 + e * 2);
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

  // 大山（名所）と、そのまわりの「守れない」範囲
  if (peak >= 0) {
    const [X, Y] = T(tx(peak) + 0.5, ty(peak) + 0.5), m = Math.min(64, Math.max(12, s * 2.2));
    if (s >= 3) {
      ctx.beginPath(); ctx.arc(X, Y, (NO_GUARD_R + 0.5) * s, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230, 80, 70, 0.12)'; ctx.fill();
      ctx.strokeStyle = '#c0392b'; ctx.lineWidth = 2; ctx.setLineDash([8, 6]); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(X - m, Y + m * 0.45); ctx.lineTo(X, Y - m * 0.55); ctx.lineTo(X + m, Y + m * 0.45); ctx.closePath();
    ctx.fillStyle = '#4a5a9a'; ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = Math.max(2, m * 0.07); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X - m * 0.36, Y - m * 0.19); ctx.lineTo(X - m * 0.15, Y - m * 0.05); ctx.lineTo(X, Y - m * 0.2);
    ctx.lineTo(X + m * 0.15, Y - m * 0.05); ctx.lineTo(X + m * 0.36, Y - m * 0.19); ctx.lineTo(X, Y - m * 0.55); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    // 頂上の旗
    ctx.beginPath(); ctx.moveTo(X, Y - m * 0.55); ctx.lineTo(X, Y - m * 1.05); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(X, Y - m * 1.05); ctx.lineTo(X + m * 0.42, Y - m * 0.92); ctx.lineTo(X, Y - m * 0.8); ctx.closePath();
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke();
    if (showLabels) {
      const fs = Math.max(11, Math.min(20, m * 0.36));
      outlined('大山', X, Y + m * 0.45 + fs * 0.7, fs);
      if (s >= 3) outlined('⚠ 守れない', X, Y + m * 0.45 + fs * 1.75, fs * 0.8, '#c0392b');
    }
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

  // 建物（丸バッジ）。引いて見ているときは小さい点だけ
  const bs = Math.min(30, Math.max(13, s * 0.85));
  for (const b of bAt.values()) {
    const [X, Y] = T(b.x + 0.5, b.y + 0.5);
    if (X < -bs || Y < -bs || X > cw + bs || Y > ch + bs) continue;
    if (s < 4) {
      ctx.beginPath(); ctx.arc(X, Y, 3, 0, Math.PI * 2);
      ctx.fillStyle = '#fffdf5'; ctx.fill(); ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.stroke();
      continue;
    }
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
    outlined(`${p.tiles.toLocaleString()}マス`, X, Y + size * 0.62, Math.max(9, size * 0.42), '#555');
  }
  // 町の名前（ズームしたら、画面内で国名と重ならないものだけ）
  if (showLabels && s >= 20) {
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
    const r = Math.max(6, ((m.type === 'warhead' ? WARHEAD_R : m.type === 'mirv' ? 3 : NUKE[m.type].r) + 0.5) * s);
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
      const R = Math.max(10, (e.r + 0.5) * s) * (0.4 + t * 1.2);
      const grad = ctx.createRadialGradient(X, Y, 0, X, Y, R);
      grad.addColorStop(0, `rgba(255,255,230,${1 - t})`);
      grad.addColorStop(0.4, `rgba(255,170,40,${0.9 * (1 - t)})`);
      grad.addColorStop(1, 'rgba(255,60,20,0)');
      ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(X, Y, R, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(X, Y, Math.max(10, (e.r + 0.5) * s) * (0.5 + t * 2), 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,255,255,${0.8 * (1 - t)})`; ctx.lineWidth = 4 * (1 - t) + 1; ctx.stroke();
    } else if (e.kind === 'cell') {
      const R = Math.max(6, s) * (0.5 + t * 0.8);
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = e.color; ctx.lineWidth = 4; ctx.strokeRect(X - R, Y - R, R * 2, R * 2);
      ctx.strokeStyle = '#222'; ctx.lineWidth = 1; ctx.strokeRect(X - R - 2, Y - R - 2, R * 2 + 4, R * 2 + 4);
      ctx.globalAlpha = 1;
    } else {
      ctx.globalAlpha = 1 - t;
      ctx.beginPath(); ctx.arc(X, Y, 4 + t * Math.max(10, s), 0, Math.PI * 2);
      ctx.strokeStyle = e.color; ctx.lineWidth = 3; ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

// 自分の国の形（上のバーの詳細に出す）
function drawSilhouette() {
  const c = $('silhouette'), g = c.getContext('2d'), P = players[me];
  g.clearRect(0, 0, c.width, c.height);
  if (!P || !P.tiles) return;
  let x0 = W, y0 = H, x1 = 0, y1 = 0;
  for (let i = 0; i < N; i++) if (owner[i] === me) {
    const x = i % W, y = (i / W) | 0;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1, k = Math.min((c.width - 8) / bw, (c.height - 8) / bh, 14);
  const ox = (c.width - bw * k) / 2, oy = (c.height - bh * k) / 2;
  const id = g.createImageData(c.width, c.height), d = id.data;
  const fill = (px, py, size, rgb) => {
    for (let yy = Math.max(0, py); yy < Math.min(c.height, py + size); yy++)
      for (let xx = Math.max(0, px); xx < Math.min(c.width, px + size); xx++) {
        const p = (yy * c.width + xx) * 4;
        d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 255;
      }
  };
  const size = Math.max(1, Math.ceil(k));
  for (let pass = 0; pass < 2; pass++) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (owner[y * W + x] !== me) continue;
      const px = Math.floor(ox + (x - x0) * k), py = Math.floor(oy + (y - y0) * k);
      if (pass === 0) fill(px - 2, py - 2, size + 4, [34, 34, 34]);
      else fill(px, py, size, P.rgb);
    }
  }
  g.putImageData(id, 0, 0);
}

// ===== カメラ =====
function fitCamera() {
  const cw = canvas.clientWidth, ch = canvas.clientHeight;
  const ui = !$('infoCard').classList.contains('hidden');
  const top = ui ? $('infoCard').getBoundingClientRect().bottom + 12 : 40;
  const bottom = ui ? ch - $('caption').getBoundingClientRect().top + 4 : 40;
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
  clampCam();
}
function centerOn(x, y, s) {
  if (s) cam.s = s;
  cam.x = canvas.clientWidth / 2 - x * cam.s;
  cam.y = canvas.clientHeight / 2 - y * cam.s;
  clampCam();
}
// 画面がマップの外に出ないようにする（スライドしすぎて海だけの所で迷子にならないように）。
// マップが画面より小さいときは真ん中に置く
function clampCam() {
  const fit = (c, size, view) => {
    const m = Math.min(80, view * 0.2);   // 端は少しだけはみ出せる
    return size + m * 2 <= view ? (view - size) / 2 : Math.min(m, Math.max(view - size - m, c));
  };
  cam.x = fit(cam.x, W * cam.s, canvas.clientWidth);
  cam.y = fit(cam.y, H * cam.s, canvas.clientHeight);
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
    pinch = { d: Math.max(40, Math.hypot(a.x - b.x, a.y - b.y)), s: cam.s };
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
    if (drag.moved && !pinch) { cam.x = drag.cx + dx; cam.y = drag.cy + dy; clampCam(); }
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
  if (savedOwner) { toast('前日の勢力図を表示中です'); return; }
  if (state === 'spawn') {   // スタート地点はポップアップで確認してから決める
    if (t >= 0 && terrain[t]) {
      if (t === selTile) { hideSel(); startGame(t); return; }
      showSpawnSel(t);
    } else { hideSel(); toast('陸地を選んでね'); }
    return;
  }
  if (state !== 'play') return;
  if (button === 2) { setMode(null); hideSel(); return; }
  if (t < 0) { hideSel(); return; }
  const P = players[me];
  if (mode && BUILD[mode] && online) { onlineSend('/api/build', { type: mode, cell: t }); setMode(null); return; }
  if (mode && NUKE[mode] && online) { onlineSend('/api/nuke', { type: mode, cell: t }); setMode(null); return; }
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
    if (o === me) {
      action = shield[i] || noGuard(i) ? null : '守る';
      if (shield[i]) sub += '（もう守っています）';
      else if (noGuard(i)) sub += '（⚠ 大山のまわりは守れません）';
    }
    else {
      const err = canTake(P, i);
      if (err) sub += `（${err}）`;
      else action = o >= 0 && shield[i] ? '盾をこわす' : '取る！';
    }
  }
  if (P.actions <= 0) { action = null; sub += online ? '（今日の1マスは使いました。日本時間0時に回復）' : '（今日はもう動けません）'; }
  $('selTitle').textContent = title;
  $('selSub').textContent = sub;
  go.textContent = action || '—';
  go.disabled = !action;
  go.classList.toggle('guard', action === '守る');
  $('selPop').classList.remove('hidden');
}
function showSpawnSel(i) {
  selTile = i;
  $('selTitle').textContent = `${town(i)}に建国する？`;
  $('selSub').textContent = 'ここがあなたの国のスタート地点になります';
  $('selGo').textContent = '建国する';
  $('selGo').disabled = false;
  $('selGo').classList.remove('guard');
  $('selPop').classList.remove('hidden');
}
function hideSel() { selTile = -1; $('selPop').classList.add('hidden'); }
$('selGo').addEventListener('click', () => {
  if (selTile < 0) return;
  if (state === 'spawn') { const t = selTile; hideSel(); startGame(t); return; }
  doPlayerAction(selTile);
});
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
  $('cName').textContent = online && online.me ? `${P.name}（${online.me.name}）` : P.name;
  $('cSwatch').style.background = P.color;
  $('cSub').textContent = online ? `・オンライン シーズン${online.seasonNo}` : '・' + diff.label;
  const rank = ranking().indexOf(P) + 1;
  $('cRank').textContent = P.alive ? `${rank}位` : '滅亡';
  $('cTiles').textContent = P.tiles;
  const d = P.tiles - yesterdayTiles;
  $('cDelta').textContent = '前日比 ' + (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d);
  $('cGold').textContent = fmt(P.gold);
  $('wGold').textContent = fmt(P.gold);
  $('cDay').textContent = Math.min(day, SEASON_DAYS);
  $('cIncome').textContent = playerIncome(P);
  $('cShields').textContent = shieldCount(P);
  $('cLeft').textContent = Math.max(0, SEASON_DAYS - day + 1);
  $('cDayInfo').innerHTML = state === 'spawn' ? 'スタート地点をえらぶ'
    : state === 'busy' ? 'ほかの国が動いています…'
    : prevOwner && savedOwner ? '前日の勢力図'
    : online && !P.actions ? `今日の1マス：<b>${untilMidnight()}</b> 後`
    : P.actions ? '今日の1マス：<b>まだ</b>' : '今日の1マス：<b>済み</b>';
  $('btnPass').disabled = state !== 'play';
  $('btnPass').classList.toggle('hidden', !!online);
  const incoming = missiles.some((m) => m.owner !== me && (m.victim === me || (m.type === 'warhead' && owner[m.ty * W + m.tx] === me)));
  $('nukeAlert').classList.toggle('hidden', !incoming);

  for (const b of document.querySelectorAll('.bbtn')) {
    const k = b.dataset.type;
    const cost = BUILD[k] ? buildCost(P, k) : nukeCost(k);
    b.querySelector('.cs').textContent = '💰' + fmt(cost);
    b.disabled = state !== 'play' || P.gold < cost || (NUKE[k] && !P.cnt.silo) || (online && !online.me);
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
      <span class="v">${p.tiles.toLocaleString()}マス</span>
      <span class="v">👥${p.members.toLocaleString()}人</span>
      <span class="v">${(p.tiles / landCount * 100).toFixed(1)}%</span>
    </div>`).join('');
}
function renderRecent() {
  $('sheet').innerHTML = '<h3>最近のできごと</h3>' + (logs.length ? logs.slice().reverse().slice(0, 60).map((l) => `
    <div class="lg ${l.cls}"><span class="sw" style="background:${l.color}"></span>${esc(l.text)}<span class="ago">${agoText(l.day)}</span></div>`).join('') : '<p>まだ何も起きていません</p>');
}
function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const agoText = (d) => (d === day ? '今日' : d === day - 1 ? '昨日' : `${day - d}日前`);
// 日本時間0時までの残り時間
function untilMidnight() {
  const jst = Date.now() + 9 * 3600e3, left = 864e5 - (jst % 864e5);
  return `${Math.floor(left / 3600e3)}:${String(Math.floor(left / 60e3) % 60).padStart(2, '0')}`;
}

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
  if (tab === 'prev') { togglePrev(); return; }
  if (tab === 'settings' && sheetTab !== 'settings') {
    closeSheet();
    sheetTab = 'settings';
    $('sheet').innerHTML = '<h3>設定</h3><div class="settings"><button id="btnToTitle">タイトルにもどる</button><button id="btnFit">マップ全体を見る</button></div>';
    $('sheet').classList.remove('hidden');
    $('btnToTitle').onclick = () => { leaveOnline(); restorePrev(); closeSheet(); state = 'menu'; ['infoCard', 'sideBtns', 'bottom'].forEach((id) => $(id).classList.add('hidden')); $('menu').classList.remove('hidden'); $('endCard').classList.add('hidden'); $('joinCard').classList.add('hidden'); $('overlay').classList.remove('hidden'); };
    $('btnFit').onclick = () => { fitCamera(); closeSheet(); };
    return;
  }
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
$('btnStart').addEventListener('click', () => { leaveOnline(); newGame(); });
$('btnOnline').addEventListener('click', startOnline);
$('btnRestart').addEventListener('click', () => {
  leaveOnline();
  $('endCard').classList.add('hidden');
  $('menu').classList.remove('hidden');
});
$('btnWatch').addEventListener('click', () => { $('overlay').classList.add('hidden'); });
$('btnZoomIn').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s * 1.3));
$('btnZoomOut').addEventListener('click', () => zoomAt(canvas.clientWidth / 2, canvas.clientHeight / 2, cam.s / 1.3));
$('btnHome').addEventListener('click', () => { const P = players[me]; if (P.tiles) centerOn(P.lx, P.ly, Math.max(cam.s, 10)); });
$('btnCollapse').addEventListener('click', () => {
  const c = $('infoCard').classList.toggle('collapsed');
  $('btnCollapse').textContent = c ? '▼' : '▲';
});
$('btnLabels').addEventListener('click', () => {
  showLabels = !showLabels;
  $('btnLabels').classList.toggle('off', !showLabels);
});
$('btnRegion').addEventListener('click', () => {
  plainView = !plainView;
  $('btnRegion').innerHTML = plainView ? 'マスで<br>見る' : '国で<br>見る';
  if (plainView) fitCamera();
});
$('btnWeapons').addEventListener('click', () => {
  const open = $('weapons').classList.toggle('hidden');
  $('btnWeapons').classList.toggle('on', !open);
  if (open) setMode(null);
});
$('btnSettings').addEventListener('click', () => openSheet('settings'));

// 前日の勢力図：きのうの地図に切りかえて見る（見ている間は操作できない）
function togglePrev() {
  if (savedOwner) { restorePrev(); return; }
  if (!prevOwner || prevOwner.length !== N) { toast('まだ前日の記録がありません（1日進むと見られます）'); return; }
  closeSheet(); hideSel(); setMode(null);
  savedOwner = owner;
  owner = prevOwner;
  if (online) online.ready = false;   // 見ている間に届いた更新は、もどってからまとめて反映する
  mapDirty = true; scan();
  document.querySelector('#tabs button[data-tab=prev]').classList.add('active');
  setHint('📅 前日の勢力図を表示中（もう一度押すともどる）', true);
  updateUI();
}
function restorePrev() {
  if (!savedOwner) return;
  owner = savedOwner;
  savedOwner = null;
  mapDirty = true; scan();
  document.querySelector('#tabs button[data-tab=prev]').classList.remove('active');
  setHint(null);
  if (online) { online.ready = true; flushBuffer(); }
  updateUI();
}
window.addEventListener('resize', () => { if (state === 'menu' || state === 'spawn') fitCamera(); });

// ===== オンライン対戦 =====
// 最初に地図をまとめて（圧縮して）受け取り、あとは変わったマスだけをリアルタイムで受け取る。
// サーバーの場所：同じドメインで配信するときは空のまま。別のドメインなら index.html で window.JINTORI_API を設定する
const API = String(window.JINTORI_API || '').replace(/\/$/, '');
const TOKEN_KEY = 'jintoriToken';
const loadToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } };
const saveToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch { /* 保存できなくても遊べる */ } };

async function api(path, body) {
  const res = await fetch(API + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'X-Player-Token': online ? online.token : loadToken() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `サーバーエラー（${res.status}）`);
  return data;
}

// 地図（持ち主・盾・汚染）をまとめて受け取る。戻り値はその時点の配信番号
async function fetchMap() {
  const res = await fetch(API + '/api/map', { headers: { 'X-Player-Token': online.token } });
  if (!res.ok) throw new Error(`地図を読み込めません（${res.status}）`);
  const seq = +res.headers.get('x-seq') || 0;
  const buf = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (buf.length !== N * 2) throw new Error('地図の大きさが合いません');
  for (let i = 0; i < N; i++) {
    const o = buf[i], f = buf[N + i];
    owner[i] = o === 255 ? -1 : o;
    shield[i] = f & 1;
    fallout[i] = f >> 1;
  }
  mapDirty = true;
  return seq;
}

async function startOnline() {
  leaveOnline();
  $('menuMsg').textContent = 'サーバーに接続中…';
  online = { token: loadToken(), me: null, seasonNo: 0, costs: null, nukeCosts: null, seed: null, ws: null, poll: 0,
    seq: 0, ready: false, buffer: [], chain: Promise.resolve(), resyncing: false, shownEnd: false };
  let data;
  try {
    data = await api('/api/state');
    online.me = data.me;
    ['infoCard', 'sideBtns', 'bottom'].forEach((id) => $(id).classList.remove('hidden'));
    setupMap(data.meta);
    connectSocket();
    online.seq = await fetchMap();
  } catch (e) {
    leaveOnline();
    $('menuMsg').textContent = location.protocol === 'file:' || !location.host
      ? 'オンライン対戦はサーバー（Cloudflare）に置いたページから遊べます'
      : 'オンライン対戦のサーバーにつながりません：' + e.message;
    return;
  }
  $('menuMsg').textContent = '';
  mode = null; selTile = -1; missiles = []; effects = [];
  closeSheet(); hideSel(); setHint(null);
  buildButtons();
  applyMeta(data.meta);
  scan();
  fitCamera();
  online.ready = true;
  flushBuffer();
  if (!data.me) showJoin(data.meta);
  else { $('overlay').classList.add('hidden'); centerOnMe(); }
}

function leaveOnline() {
  if (!online) return;
  clearInterval(online.poll);
  if (online.ws) { online.ws.onclose = null; online.ws.close(); }
  online = null;
}

// 新しいマップ（シーズン）なら地図を作り直す
function setupMap(meta) {
  if (online.seed === meta.seed) return;
  setDims(meta.W, meta.H);
  genMap(meta.seed);
  owner = new Int16Array(N).fill(-1);
  shield = new Uint8Array(N);
  fallout = new Uint8Array(N);
  players = meta.nations.map((n) => Object.assign(makePlayer(n.id, n.name, n.color, false), { capital: n.capital, members: n.members }));
  online.seed = meta.seed;
  online.seq = 0;
  prevOwner = null; savedOwner = null;
  mapDirty = true;
}

// 地図以外の情報（国・建物・ログ・日付）を反映する
function applyMeta(meta) {
  online.date = meta.date;
  online.seasonNo = meta.seasonNo;
  online.costs = meta.costs;
  online.nukeCosts = meta.nukeCosts;
  for (const n of meta.nations) {
    const p = players[n.id];
    p.members = n.members; p.capital = n.capital; p.tiles = n.tiles;
    p.cnt = { city: 0, silo: 0, sam: 0 };
    p.gold = 0; p.actions = 0;
  }
  bAt = new Map(meta.buildings.map((b) => [b.i, { type: b.type, i: b.i, x: tx(b.i), y: ty(b.i), owner: b.nation, cd: b.cd }]));
  for (const b of bAt.values()) players[b.owner].cnt[b.type]++;
  me = online.me ? online.me.nation : 0;
  if (online.me) { players[me].gold = online.me.gold; players[me].actions = online.me.actedToday ? 0 : 1; }
  day = meta.day;
  logs = meta.logs.map((l) => ({ text: l.text, cls: l.cls, day: l.day, color: l.nation >= 0 ? meta.nations[l.nation].color : '#ccc' }));
  const last = logs[logs.length - 1];
  if (last) ticker(last.text, last.color, agoText(last.day));
  state = online.me && !meta.ended ? 'play' : 'watch';
  if (meta.ended && !online.shownEnd) {
    online.shownEnd = true;
    const w = meta.nations[meta.winner];
    $('endTitle').textContent = online.me && w && w.id === online.me.nation ? '🎉 優勝！' : '🏁 シーズン終了';
    $('endText').textContent = w ? `シーズン${meta.seasonNo}の優勝は ${w.name}（${w.tiles.toLocaleString()}マス）！次のシーズンをお待ちください。` : '';
    $('menu').classList.add('hidden'); $('joinCard').classList.add('hidden');
    $('endCard').classList.remove('hidden'); $('overlay').classList.remove('hidden');
  }
}

function applyCells(cells) {
  for (let k = 0; k < cells.length; k += 3) {
    const i = cells[k], o = cells[k + 1], f = cells[k + 2];
    owner[i] = o === 255 ? -1 : o;
    shield[i] = f & 1;
    fallout[i] = f >> 1;
    markCell(i);
  }
}

// 画面の数字やラベルを更新（大きいマップなので、続けて来ても0.5秒に1回まで）
let refreshTimer = 0;
function refresh() {
  if (refreshTimer) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = 0;
    if (!online) return;
    scan();
    if (selTile >= 0) showSel(selTile);
    updateUI();
  }, 500);
}

function handleDiff(msg) {
  if (!online.ready) { online.buffer.push(msg); return; }
  if (msg.seq <= online.seq) return;                       // 地図に入っている古い分
  if (msg.seq > online.seq + 1) { resync(); return; }      // 取りこぼした → 地図を取り直す
  online.seq = msg.seq;
  const nukes = (msg.events || []).filter((e) => e.kind === 'nuke');
  // 核が飛んできたときは、着弾してから地図を書き換える
  online.chain = online.chain.then(() => {
    let delay = 0;
    for (const e of nukes) delay = Math.max(delay, animateNuke(e));
    return new Promise((r) => setTimeout(r, delay));
  }).then(() => {
    if (!online) return;
    if (online.date && msg.meta.date !== online.date) prevOwner = owner.slice();   // 日付が変わった → 前日の勢力図として残す
    applyCells(msg.cells);
    applyMeta(msg.meta);
    refresh();
  });
}
function flushBuffer() {
  const buf = online.buffer;
  online.buffer = [];
  buf.forEach(handleDiff);
}

async function resync() {
  if (!online || online.resyncing) return;
  online.resyncing = true;
  online.ready = false;
  try {
    const d = await api('/api/state');
    online.me = d.me;
    if (d.meta.seed !== online.seed) { setupMap(d.meta); fitCamera(); }
    online.seq = await fetchMap();
    applyMeta(d.meta);
  } catch { /* 次の機会にまた試す */ }
  if (!online) return;
  online.resyncing = false;
  online.ready = true;
  flushBuffer();
  refresh();
}

function animateNuke(e) {
  const now = performance.now(), dist = Math.hypot(tx(e.to) - tx(e.from), ty(e.to) - ty(e.from));
  const dur = 1100 + Math.min(dist, 60) * 70;
  const m = { type: e.type, owner: e.nation, sx: tx(e.from), sy: ty(e.from), tx: tx(e.to), ty: ty(e.to), start: now, dur, intercept: -1, visual: true, victim: owner[e.to] };
  if (e.interceptBy != null) { m.intercept = 0.82; m.samX = tx(e.interceptBy); m.samY = ty(e.interceptBy); m.samOwner = -1; }
  else if (!e.warheads) m.boomR = NUKE[e.type].r;
  missiles.push(m);
  let end = e.interceptBy != null ? dur * 0.82 : dur;
  for (const w of e.warheads || []) {
    const wd = 500 + Math.min(Math.hypot(tx(w) - tx(e.to), ty(w) - ty(e.to)), 60) * 60;
    missiles.push({ type: 'warhead', owner: e.nation, sx: tx(e.to), sy: ty(e.to), tx: tx(w), ty: ty(w), start: now + dur, dur: wd, intercept: -1, visual: true, boomR: WARHEAD_R });
    end = Math.max(end, dur + wd);
  }
  if (online.me && m.victim === online.me.nation) toast('☢ 核ミサイルが飛んできた！');
  return end + 50;
}

async function onlineSend(path, body) {
  try {
    const data = await api(path, body);
    online.me = data.me;
    // 核は、みんなと同じ配信（ミサイルの演出つき）で反映する
    if (path !== '/api/nuke') applyCells(data.cells || []);
    applyMeta(data.meta);
    if (path === '/api/act' && data.cells && data.cells.length) pop(data.cells[0], players[me].color);
    refresh();
  } catch (e) { toast(e.message); }
}

function showJoin(meta) {
  $('menu').classList.add('hidden');
  $('endCard').classList.add('hidden');
  $('joinCard').classList.remove('hidden');
  $('overlay').classList.remove('hidden');
  $('joinNations').innerHTML = meta.nations.map((n) => `
    <button class="nation" data-id="${n.id}">
      <span class="sw" style="background:${n.color}"></span>
      <span class="nm">${esc(n.name)}</span>
      <small>${n.tiles.toLocaleString()}マス・👥${n.members.toLocaleString()}人</small>
    </button>`).join('');
}
$('joinNations').addEventListener('click', async (e) => {
  const b = e.target.closest('.nation');
  if (!b || !online) return;
  const name = $('joinName').value.trim();
  if (!name) { $('joinMsg').textContent = '名前を入れてください'; return; }
  $('joinMsg').textContent = '参加しています…';
  try {
    const data = await api('/api/join', { nation: +b.dataset.id, name });
    saveToken(data.token);
    online.token = data.token;
    online.me = data.me;
    $('joinMsg').textContent = '';
    $('overlay').classList.add('hidden');
    $('joinCard').classList.add('hidden');
    applyMeta(data.meta);
    scan();
    updateUI();
    centerOnMe();
  } catch (err) { $('joinMsg').textContent = err.message; }
});
$('joinBack').addEventListener('click', () => {
  leaveOnline();
  $('joinCard').classList.add('hidden');
  $('menu').classList.remove('hidden');
});
function centerOnMe() { const P = players[me]; if (P && P.tiles) centerOn(P.lx, P.ly, Math.max(cam.s, 6)); }

// リアルタイム更新。つながらないときは30秒ごとに、つながっていても10分ごとに地図を取り直す
function connectSocket() {
  if (!online) return;
  clearInterval(online.poll);
  let ticks = 0;
  online.poll = setInterval(() => {
    if (!online) return;
    ticks++;
    if (!online.ws || online.ws.readyState !== 1 || ticks % 20 === 0) resync();
  }, 30000);
  let url;
  try {
    const base = API ? new URL(API) : location;
    url = `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/api/ws`;
  } catch { return; }
  const ws = new WebSocket(url);
  online.ws = ws;
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (!online) return;
    if (msg.type === 'diff') handleDiff(msg);
    else if (msg.type === 'reload') { online.shownEnd = false; resync(); }
  };
  ws.onclose = (e) => {
    if (!online || online.ws !== ws) return;
    if (e.code === 4003) { toast('この回線からは参加できません'); return; }
    setTimeout(() => { if (online && online.ws === ws) { connectSocket(); resync(); } }, 5000);
  };
}
setInterval(() => { if (online && state === 'play' && !players[me].actions) updateUI(); }, 30000);

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
  get missiles() { return missiles; }, get landCount() { return landCount; }, get online() { return online; },
  flushMissiles() { for (let k = 0; k < 3; k++) updateMissiles(performance.now() + 1e7 * (k + 1)); },
  owner: () => owner, shield: () => shield, launchNuke, placeBuilding, doPlayerAction, advanceDay, canTake,
  // テスト用：あなたの1マスを自動で選んで動く
  autoMe() {
    const f = buildFrontiers()[me], ok = (i) => canTake(players[me], i) === null;
    const i = pickFrom(f.neutral.length ? f.neutral : f.enemy, ok, () => 0);
    if (i >= 0) doPlayerAction(i); else passDay();
  },
};
})();
