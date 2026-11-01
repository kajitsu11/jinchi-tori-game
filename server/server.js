// 47都道府県対抗 陣取り合戦 — オンライン版サーバー
//   node server/server.js            （PORT=8080・GRID_SCALE=3）
//
// ・地図とルール（src/core.js・src/rts_sim.js）はブラウザ版と同じものを使い、サーバーだけが全体を持つ（約4900万マス）
// ・ブラウザには「日本全体の粗い持ち主（1/3 の解像度）」と「画面の周りの細かい持ち主（64×64マスの区画）」だけを送る
// ・兵士・建物は、それぞれの人の画面に映っている範囲だけを 0.5 秒ごとに送る
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { loadEngine, loadMaps, ROOT } = require('./engine');
const persist = require('./persist');

const PORT = +(process.env.PORT || 8080);
const S = +(process.env.GRID_SCALE || 3);           // 地図の細かさ（元の地図の1マスを S×S に分ける）
const SPEED = +(process.env.SPEED || 1);            // 確認用の早送り
const SEED = +(process.env.SEED || (Date.now() & 0x7fffffff));
const SAVE_FILE = process.env.SAVE_FILE || path.join(ROOT, 'server', 'season.sav');   // シーズンの保存先
const SAVE_MS = +(process.env.SAVE_MS || 300000);   // 5分ごとに保存
const SNAP_MS = 500;                                // 兵士・建物を送る間隔
const MAX_SUBS = 600;                               // 1人が同時に受け取れる細かい区画の数
const MAX_UNITS = 2500, MAX_BUILDINGS = 4000;
const NODE_TYPES = ['capital', 'town', 'fort', 'castle'];

const E = loadEngine();
const { CONFIG, BUILDINGS } = E;
const TYPES = E.BUILD_ORDER, UNIT_TYPES = Object.keys(E.UNITS);

/** RLE（値＋可変長の長さ）。ブラウザ版の地図データと同じ形式 */
function rle(arr, from = 0, to = arr.length) {
  const out = [];
  let i = from;
  while (i < to) {
    const v = arr[i];
    let j = i + 1;
    while (j < to && arr[j] === v) j++;
    let L = j - i;
    out.push(v);
    for (;;) { const b = L & 127; L >>>= 7; if (L) out.push(b | 128); else { out.push(b); break; } }
    i = j;
  }
  return Buffer.from(out);
}
function frame(kind, idx, body) {
  const h = Buffer.alloc(5);
  h[0] = kind; h.writeUInt32LE(idx >>> 0, 1);
  return Buffer.concat([h, body]);
}

class Season {
  constructor(coarse, fine, resume) {
    this.coarse = coarse; this.fine = fine;
    const t0 = Date.now();
    Season.count = (Season.count || 0) + 1;
    this.seasonNo = Season.count;
    this.sim = new E.Sim(fine, 0, (SEED + Season.count - 1) >>> 0);   // シーズンごとに違う展開
    this.accounts = new Map();                      // token → { w, pref, name }
    // 保存したシーズンがあれば続きから
    if (resume) {
      try { if (persist.load(this, SAVE_FILE)) { Season.count = this.seasonNo; console.log(`resumed season ${this.seasonNo} at t=${this.sim.time.toFixed(0)}s`); } }
      catch (e) { console.error('could not load save file:', e.message); }
    }
    console.log(`season ready in ${Date.now() - t0}ms: nodes ${this.sim.nodes.length}, units ${this.sim.units.length}`);
    this.startedAt = Date.now();
    // 粗い持ち主（元の地図の1マスごと。そのマスの中央の細かいマスの持ち主。最近占領なら +64）
    // 送るときは「元の県のままなら 0」にする（ブラウザは元の県を知っている）。長い同じ値の並びになり、小さく送れる
    this.cown = new Uint8Array(coarse.N);
    for (let ci = 0; ci < coarse.N; ci++) {
      if (!coarse.initPref[ci]) continue;
      const i = fine.id(coarse.X(ci) * S + (S >> 1), coarse.Y(ci) * S + (S >> 1));
      this.cown[ci] = this.ownerByte(i);
    }
    this.coarseDirty = new Set();
    this.fineDirty = new Set();                     // 細かい区画（番号 = 区画の y×TW + x）
    this.tileGrid = new Int32Array(fine.nTiles);    // マスの番号>>12（通し番号）→ 区画の座標の番号
    for (let t = 0; t < fine.nTiles; t++) this.tileGrid[t] = fine.tileY[t] * fine.TW + fine.tileX[t];
    this.fullCoarse = null;
    this.deaths = [];
    this.events = [];
    this.countNodeCells();
    this.nodeSent = [];
    const g = this.sim;
    g.on('cells', (cells) => this.onCells(cells));
    g.on('death', (u) => { if (this.deaths.length < 4000) this.deaths.push(u.x, u.y, u.pref, u.id); });
    g.on('capture', (e) => this.events.push({ k: 'capture', node: e.node.id, from: e.from, by: e.by }));
    g.on('eliminated', (p) => this.events.push({ k: 'elim', p }));
    g.on('built', (e) => { if (e.byPlayer) { const o = e.building || e.node; this.events.push({ k: 'built', w: e.wallet, type: e.type, x: o.x, y: o.y }); } });
    g.on('destroyed', (b) => { if (b.byPlayer) this.events.push({ k: 'destroyed', w: b.wallet, type: b.type, x: b.x, y: b.y }); });
    g.on('over', (o) => this.events.push({ k: 'over', o }));
    g.on('flag', (e) => this.events.push({ k: 'flag', kind: e.kind, f: { id: e.flag.id, x: e.flag.x, y: e.flag.y, pref: e.flag.pref, hw: e.flag.hw }, cells: e.cells || 0 }));
  }
  /** 拠点ごとの領土のマス数（全部のマスを数えるので、30秒に1回だけ） */
  countNodeCells() {
    const g = this.sim, cnt = new Int32Array(g.nodes.length + 1), nodeOf = g.nodeOf, L = g.landIdx;
    for (let k = 0; k < L.length; k++) cnt[nodeOf[L[k]] + 1]++;
    this.nodeCells = cnt.subarray(1);
  }
  ownerByte(i) {
    if (i < 0) return 0;
    const o = this.sim.owner[i];
    if (!o) return 0;
    return (o === this.fine.initPref[i] ? 0 : o) | (this.sim.isRecent(i) ? 64 : 0);
  }
  onCells(cells) {
    const f = this.fine, c = this.coarse, h = S >> 1;
    for (const i of cells) {
      this.fineDirty.add(this.tileGrid[i >> 12]);
      const x = f.X(i), y = f.Y(i);
      if (x % S !== h || y % S !== h) continue;
      const ci = c.id((x / S) | 0, (y / S) | 0);
      if (ci < 0) continue;
      this.cown[ci] = this.ownerByte(i);
      this.coarseDirty.add(ci >> 12);
    }
    this.fullCoarse = null;
  }
  coarseSnapshot() {
    if (!this.fullCoarse) this.fullCoarse = frame(1, 0, rle(this.cown));
    return this.fullCoarse;
  }
  /** 細かい区画（番号 = 区画の y×TW + x）の持ち主。海だけの区画は 0 だけ */
  fineTile(t) {
    const b = this.fine.tileBase[t];
    const buf = new Uint8Array(4096);
    if (b >= 0) for (let k = 0; k < 4096; k++) buf[k] = this.ownerByte(this.fine.initPref[b + k] ? b + k : -1);
    return frame(3, t, rle(buf));
  }
  nodeRecord(n) {
    return [n.id, Math.round(n.x * 10), Math.round(n.y * 10), n.pref, n.owner, NODE_TYPES.indexOf(n.type), n.name,
      this.nodeCells[n.id] || 0, n.wallet, Math.round(n.capturedAt),
      Math.floor(n.progress / this.sim.needFor(n) * 1000), n.capBy, n.attackers, n.defenders];
  }
  nodeSig(n) {
    return `${n.owner}|${Math.floor(n.progress / this.sim.needFor(n) * 200)}|${n.capBy}|${n.attackers}|${n.defenders}|${n.wallet}`;
  }
}

let maps = null, season = null;
const perf = { simMs: 0, sendMs: 0, bytes: 0, msgs: 0 };   // 直近の処理時間（ミリ秒）と送信量
const clients = new Set();

function send(ws, obj) {
  if (ws.readyState !== 1) return;
  const data = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  perf.bytes += data.length; perf.msgs++;
  ws.send(data);
}

function globalStats() {
  const g = season.sim;
  const units = new Int32Array(49);
  for (const u of g.units) units[u.pref]++;
  const blds = new Int32Array(49);
  for (const b of g.buildings) blds[b.owner]++;
  return {
    time: g.time, pop: Array.from(g.pop.slice(0, 48), (v) => Math.round(v * 10) / 10), counts: Array.from(g.counts.slice(0, 48)),
    nodeCount: Array.from(g.nodeCount.slice(0, 48)), units: Array.from(units.slice(0, 48)), blds: Array.from(blds.slice(0, 48)),
    parts: Array.from(g.parts.slice(0, 48)), humans: Array.from(g.humansIn.slice(0, 48)), caps: Array.from({ length: 48 }, (_, p) => (p ? g.unitCap(p) : 0)),
    online: clients.size, over: g.over,
  };
}

function onMessage(cl, msg) {
  const g = season.sim;
  if (msg.t === 'hello') {
    let acc = msg.token && season.accounts.get(msg.token);
    if (!acc) {
      const pref = msg.pref | 0;
      if (pref < 1 || pref > 47) return send(cl.ws, { t: 'error', why: 'pref' });
      if (g.nodeCount[pref] === 0) return send(cl.ws, { t: 'error', why: 'eliminated' });
      const name = String(msg.name || '').slice(0, 16) || '名無し';
      const token = crypto.randomBytes(16).toString('hex');
      acc = { token, w: g.addHuman(pref, name), pref, name };
      season.accounts.set(token, acc);
    }
    cl.acc = acc;
    send(cl.ws, {
      t: 'welcome', token: acc.token, w: acc.w, pref: acc.pref, name: acc.name, S, seasonDays: CONFIG.SEASON_DAYS, speed: SPEED,
      fineTW: season.fine.TW, fineTH: season.fine.TH, popTotal: g.popTotal,
      nodes: g.nodes.map((n) => season.nodeRecord(n)),
    });
    send(cl.ws, season.coarseSnapshot());
    cl.sentNodes = g.nodes.length;
    sendStats(cl, globalStats());
    return;
  }
  if (!cl.acc) return;
  const w = cl.acc.w;
  switch (msg.t) {
    case 'view': {
      const v = msg;
      cl.view = { x0: +v.x0 || 0, y0: +v.y0 || 0, x1: +v.x1 || 0, y1: +v.y1 || 0, u: !!v.u, b: !!v.b };
      break;
    }
    case 'sub': {
      for (const t of msg.del || []) cl.subs.delete(t | 0);
      for (const t0 of msg.add || []) {
        const t = t0 | 0;
        if (t < 0 || t >= season.fine.TW * season.fine.TH || cl.subs.has(t) || cl.subs.size >= MAX_SUBS) continue;
        cl.subs.add(t);
        send(cl.ws, season.fineTile(t));
      }
      break;
    }
    case 'build': {
      const type = String(msg.type);
      if (!BUILDINGS[type]) return;
      const cell = season.fine.id(Math.floor(+msg.x), Math.floor(+msg.y));
      const r = g.humanBuild(w, type, cell);
      send(cl.ws, { t: 'buildres', ok: r.ok, why: r.why || null, type, x: +msg.x, y: +msg.y });
      break;
    }
    case 'rally': {
      const id = msg.node | 0;
      g.setRally(id >= 0 && id < g.nodes.length ? id : -1, w);
      break;
    }
    case 'ping': send(cl.ws, { t: 'pong', at: msg.at }); break;
  }
}

function sendStats(cl, gs) {
  const g = season.sim, w = cl.acc.w, h = g.humans.get(w);
  send(cl.ws, {
    t: 'stats', ...gs,
    res: { food: g.res.food[w], wood: g.res.wood[w], gold: g.res.gold[w] }, income: h ? h.income : null,
    myB: g.myBuildings(w), myU: g.myUnits(w), rally: h ? h.rally : -1,
  });
}

/** 画面の範囲（＋余白）にある兵士・建物を送る。建物は前回から変わったものだけ */
function sendSnapshot(cl) {
  const g = season.sim, v = cl.view, w = cl.acc.w;
  if (!v) return;
  const m = 8;
  const x0 = Math.max(0, v.x0 - m), y0 = Math.max(0, v.y0 - m), x1 = Math.min(season.fine.W, v.x1 + m), y1 = Math.min(season.fine.H, v.y1 + m);
  const inside = (x, y) => x >= x0 && x <= x1 && y >= y0 && y <= y1;
  const out = { t: 'snap', time: g.time };
  if (v.u) {
    const U = [];
    const hs = g.hs, bx0 = (x0 / hs) | 0, bx1 = Math.min(g.hw - 1, (x1 / hs) | 0), by0 = (y0 / hs) | 0, by1 = Math.min(g.hh - 1, (y1 / hs) | 0);
    for (let by = by0; by <= by1 && U.length < MAX_UNITS * 8; by++) for (let bx = bx0; bx <= bx1; bx++) {
      for (let k = g.head[by * g.hw + bx]; k >= 0; k = g.next[k]) {
        const u = g.units[k];
        if (!u || !u.alive || !inside(u.x, u.y)) continue;
        const flags = (u.engaged >= 0 ? 1 : 0) | (u.hitB ? 2 : 0) | (u.fromPlayer ? 4 : 0) | (u.hw === w ? 8 : 0);
        U.push(u.id, Math.round(u.x * 10), Math.round(u.y * 10), u.pref, Math.max(0, Math.round(u.hp)), flags, u.engaged, UNIT_TYPES.indexOf(u.type));
      }
    }
    out.u = U;
    const D = [];
    const dd = season.deaths;
    for (let k = 0; k < dd.length; k += 4) if (inside(dd[k], dd[k + 1])) D.push(Math.round(dd[k] * 10), Math.round(dd[k + 1] * 10), dd[k + 2], dd[k + 3]);
    out.d = D;
    out.g = (g.gas || []).filter((c) => inside(c.x, c.y)).slice(0, 200).map((c) => [Math.round(c.x * 10), Math.round(c.y * 10), c.r, Math.round(c.until - g.time)]);
    out.x = (g.booms || []).filter((b) => inside(b[0], b[1])).slice(0, 200).map((b) => [Math.round(b[0] * 10), Math.round(b[1] * 10), b[2], b[4], Math.round(b[5] * 10), Math.round(b[6] * 10), Math.round(b[3] * 10)]);
    out.f = (g.flags || []).filter((f) => inside(f.x, f.y)).slice(0, 300).map((f) => [f.id, Math.round(f.x * 10), Math.round(f.y * 10), f.pref, Math.round(f.prog), Math.round(f.hp), f.own ? 1 : 0, f.hw]);
    out.s = g.shots.filter((s) => inside(s[0], s[1]) || inside(s[2], s[3])).slice(0, 200).map((s) => s.map((q) => Math.round(q * 10)));
  }
  if (v.b) {
    const add = [], upd = [], seen = new Set();
    const bg = g.bgs;
    for (let by = (y0 / bg) | 0; by <= (y1 / bg) | 0; by++) for (let bx = (x0 / bg) | 0; bx <= (x1 / bg) | 0; bx++) {
      const list = g.bgrid.get(by * g.bgw + bx);
      if (!list) continue;
      for (const b of list) {
        if (seen.size >= MAX_BUILDINGS) break;
        seen.add(b.id);
        const mine = b.wallet === w ? 1 : 0;
        const sig = `${b.owner}|${mine}|${Math.ceil(b.hp)}|${b.type === 'barracks' ? Math.floor(b.t / 30) : 0}`;
        const old = cl.known.get(b.id);
        if (old === undefined) add.push([b.id, TYPES.indexOf(b.type), Math.round(b.x * 10), Math.round(b.y * 10), b.owner, Math.ceil(b.hp), b.maxHp, Math.round(b.rot * 100), mine, b.mul, b.forest, Math.round(b.t)]);
        else if (old !== sig) upd.push([b.id, b.owner, mine, Math.ceil(b.hp), Math.round(b.t), b.hitAt && g.time - b.hitAt < 3 ? 1 : 0]);
        cl.known.set(b.id, sig);
      }
    }
    const del = [];
    for (const id of cl.known.keys()) if (!seen.has(id)) { del.push(id); cl.known.delete(id); }
    out.ba = add; out.bu = upd; out.bd = del;
  } else if (cl.known.size) { out.bd = [...cl.known.keys()]; cl.known.clear(); }
  send(cl.ws, out);
}

function broadcastTick(withStats) {
  const g = season.sim;
  // 持ち主の変化：粗い区画は全員へ、細かい区画は受け取っている人へ
  const coarseFrames = [...season.coarseDirty].map((t) => frame(2, t, rle(season.cown, t << 12, (t << 12) + 4096)));
  season.coarseDirty.clear();
  const fineCache = new Map();
  for (const cl of clients) {
    if (!cl.acc) continue;
    for (const f of coarseFrames) send(cl.ws, f);
    for (const t of season.fineDirty) {
      if (!cl.subs.has(t)) continue;
      if (!fineCache.has(t)) fineCache.set(t, season.fineTile(t));
      send(cl.ws, fineCache.get(t));
    }
  }
  season.fineDirty.clear();
  // 拠点の変化（全員へ）
  const upd = [], add = [];
  for (const n of g.nodes) {
    const sig = season.nodeSig(n);
    if (season.nodeSent[n.id] === sig) continue;
    season.nodeSent[n.id] = sig;
    upd.push(season.nodeRecord(n));
  }
  const evs = season.events;
  season.events = [];
  const gs = withStats ? globalStats() : null;
  for (const cl of clients) {
    if (!cl.acc) continue;
    if (cl.sentNodes < g.nodes.length) { for (let k = cl.sentNodes; k < g.nodes.length; k++) add.push(k); cl.sentNodes = g.nodes.length; }
    if (upd.length) send(cl.ws, { t: 'nodes', n: upd });
    const mine = evs.filter((e) => e.w === undefined || e.w === cl.acc.w);
    if (mine.length) send(cl.ws, { t: 'ev', e: mine });
    sendSnapshot(cl);
    if (gs) sendStats(cl, gs);
  }
  season.deaths = [];
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: !!season, online: clients.size, time: season && season.sim.time, perf, rss: process.memoryUsage().rss })); return; }
  if (url === '/' || url === '/index.html') {
    const file = path.join(ROOT, 'online.html');
    if (!fs.existsSync(file)) { res.writeHead(500); res.end('online.html がありません（python3 tools/build.py を実行してください）'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(404); res.end('not found');
});

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 512 } });
wss.on('connection', (ws) => {
  if (!season) { ws.close(1013, 'starting'); return; }
  const cl = { ws, acc: null, view: null, subs: new Set(), known: new Map(), sentNodes: 0 };
  clients.add(cl);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let msg;
    try { msg = JSON.parse(data.toString()); } catch (e) { return; }
    try { onMessage(cl, msg); } catch (e) { console.error('message error', e); }
  });
  ws.on('close', () => clients.delete(cl));
  ws.on('error', () => clients.delete(cl));
});

(async () => {
  const t0 = Date.now();
  maps = await loadMaps(E, S);
  console.log(`map ${maps.fine.W}x${maps.fine.H}, land ${maps.fine.landCells} cells (${Date.now() - t0}ms)`);
  season = new Season(maps.coarse, maps.fine, true);
  server.listen(PORT, () => console.log(`listening on :${PORT}`));
  let last = Date.now(), snapAt = 0, statsAt = 0, restartAt = 0;
  setInterval(() => {
    const now = Date.now();
    // シーズンが終わったら、10分後に次のシーズンを始める（つないでいる人には読み込み直してもらう）
    if (season.sim.over && !restartAt) restartAt = now + +(process.env.RESTART_MS || 600000);
    if (restartAt && now >= restartAt) {
      restartAt = 0;
      for (const cl of clients) { send(cl.ws, { t: 'reset' }); cl.ws.close(); }
      season = new Season(maps.coarse, maps.fine);
      last = Date.now();
      saveNow();
      return;
    }
    const dt = Math.min(1, (now - last) / 1000);
    last = now;
    season.sim.update(dt, SPEED);
    const t1 = Date.now();
    perf.simMs = perf.simMs * 0.9 + (t1 - now) * 0.1;
    if (now >= snapAt) {
      snapAt = now + SNAP_MS;
      const st = now >= statsAt;
      if (st) statsAt = now + 1000;
      broadcastTick(st);
      perf.sendMs = perf.sendMs * 0.8 + (Date.now() - t1) * 0.2;
    }
  }, 100);
  setInterval(() => season.countNodeCells(), 30000);
  let saving = false;
  const saveNow = async () => {
    if (saving) return;
    saving = true;
    try { const r = await persist.save(season, SAVE_FILE); console.log(`saved season (${(r.bytes / 1e6).toFixed(1)}MB, ${r.ms}ms)`); }
    catch (e) { console.error('save failed:', e.message); }
    saving = false;
  };
  setInterval(saveNow, SAVE_MS);
  // 止めるとき（systemctl stop・Ctrl+C）も保存してから終わる
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { console.log('saving before exit…'); await saveNow(); process.exit(0); });
  setInterval(() => {
    const mu = process.memoryUsage();
    console.log(`t=${season.sim.time.toFixed(0)} online=${clients.size} units=${season.sim.units.length} blds=${season.sim.buildings.length} nodes=${season.sim.nodes.length} rss=${(mu.rss / 1e6) | 0}MB`);
  }, 60000);
})();
