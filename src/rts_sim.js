// =====================================================================
// RTS シミュレーション（描画から独立。将来サーバーで同じものを動かせるよう、
// 乱数は seed から、時間は固定刻み TICK で進める）
// =====================================================================
const NODE_TYPE_NAME = { capital: '県庁', town: '町', fort: '砦' };

/** 二分ヒープ（A* 用、数値キー） */
class Heap {
  constructor(cap) { this.k = new Float32Array(cap); this.v = new Int32Array(cap); this.n = 0; }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n >= this.k.length) {
      const k = new Float32Array(this.k.length * 2); k.set(this.k); this.k = k;
      const v = new Int32Array(this.v.length * 2); v.set(this.v); this.v = v;
    }
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= key) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  pop() {
    const top = this.v[0];
    const key = this.k[--this.n], val = this.v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= key) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

/** 24×24マスのブロック単位の移動グラフ（陸地を含むブロックだけ通れる。連絡マスは追加の辺） */
class NavGrid {
  constructor(map) {
    const B = 24 * (map.scale || 1), W = map.W, H = map.H;   // 24×24マス（約6km）のブロック（細かい地図では同じ広さになるよう大きく）
    this.B = B; this.W = W;
    this.bw = Math.ceil(W / B); this.bh = Math.ceil(H / B);
    const n = this.bw * this.bh;
    this.rep = new Int32Array(n).fill(-1);       // ブロック内で中心に一番近い陸地マス
    const best = new Float32Array(n).fill(1e9);
    const ip = map.initPref;
    this.map = map;
    for (let i = 0; i < map.N; i++) {
      if (!ip[i]) continue;
      const x = map.X(i), y = map.Y(i);
      const b = ((y / B) | 0) * this.bw + ((x / B) | 0);
      const dx = (x % B) - B / 2 + 0.5, dy = (y % B) - B / 2 + 0.5, d = dx * dx + dy * dy;
      if (d < best[b]) { best[b] = d; this.rep[b] = i; }
    }
    this.extra = new Map();
    for (const [a, list] of map.linkMap) {
      for (const c of list) {
        const ba = this.blockOfCell(a), bb = this.blockOfCell(c);
        if (ba === bb) continue;
        if (!this.extra.has(ba)) this.extra.set(ba, []);
        this.extra.get(ba).push(bb);
      }
    }
    this.g = new Float32Array(n);
    this.came = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.gen = 0;
    this.heap = new Heap(4096);
  }
  blockOfCell(i) { const x = this.map.X(i), y = this.map.Y(i); return ((y / this.B) | 0) * this.bw + ((x / this.B) | 0); }
  blockAt(x, y) {
    const bx = clamp((x / this.B) | 0, 0, this.bw - 1), by = clamp((y / this.B) | 0, 0, this.bh - 1);
    return by * this.bw + bx;
  }
  nearestLand(b) {
    if (this.rep[b] >= 0) return b;
    const bx = b % this.bw, by = (b / this.bw) | 0;
    for (let r = 1; r <= 6; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= this.bw || y >= this.bh) continue;
        if (this.rep[y * this.bw + x] >= 0) return y * this.bw + x;
      }
    }
    return -1;
  }
  /** (sx,sy)→(tx,ty) の経由点（マス座標）。見つからなければ null */
  find(sx, sy, tx, ty) {
    const bw = this.bw, bh = this.bh;
    const s = this.nearestLand(this.blockAt(sx, sy)), t = this.nearestLand(this.blockAt(tx, ty));
    if (s < 0 || t < 0) return null;
    if (s === t) return [];
    const gen = ++this.gen;
    const heap = this.heap; heap.clear();
    const txb = t % bw, tyb = (t / bw) | 0;
    const h = (b) => { const dx = Math.abs(b % bw - txb), dy = Math.abs(((b / bw) | 0) - tyb); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    this.g[s] = 0; this.seen[s] = gen; this.came[s] = -1;
    heap.push(h(s), s);
    let found = false, expanded = 0;
    while (heap.n) {
      const b = heap.pop();
      if (this.closed[b] === gen) continue;
      this.closed[b] = gen;
      if (b === t) { found = true; break; }
      if (++expanded > 60000) break;
      const bx = b % bw, by = (b / bw) | 0, gb = this.g[b];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const x = bx + dx, y = by + dy;
        if (x < 0 || y < 0 || x >= bw || y >= bh) continue;
        const nb = y * bw + x;
        if (this.rep[nb] < 0 || this.closed[nb] === gen) continue;
        const ng = gb + (dx && dy ? 1.414 : 1);
        if (this.seen[nb] !== gen || ng < this.g[nb]) {
          this.seen[nb] = gen; this.g[nb] = ng; this.came[nb] = b;
          heap.push(ng + h(nb), nb);
        }
      }
      const ex = this.extra.get(b);
      if (ex) for (const nb of ex) {
        if (this.closed[nb] === gen) continue;
        const L = Math.hypot(nb % bw - bx, ((nb / bw) | 0) - by);
        const ng = gb + L;
        if (this.seen[nb] !== gen || ng < this.g[nb]) {
          this.seen[nb] = gen; this.g[nb] = ng; this.came[nb] = b;
          heap.push(ng + h(nb), nb);
        }
      }
    }
    if (!found) return null;
    const pts = [];
    for (let b = t; b !== s && b >= 0; b = this.came[b]) {
      const c = this.rep[b];
      pts.push([this.map.X(c) + 0.5, this.map.Y(c) + 0.5]);
    }
    pts.reverse();
    // 間引き：3点ほぼ一直線なら真ん中を省く
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      if (out.length >= 2 && i < pts.length - 1) {
        const a = out[out.length - 2], b = out[out.length - 1], c = pts[i];
        const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
        if (Math.abs(cross) < 1e-6 && Math.hypot(c[0] - a[0], c[1] - a[1]) < 80) { out[out.length - 1] = c; continue; }
      }
      out.push(pts[i]);
    }
    return out;
  }
}

// 兵種・建物が狙える相手を数字に（1=陸 2=海 4=空）
const DOM_BIT = { land: 1, sea: 2, air: 4 };
const maskOf = (h) => (h || '').split(',').reduce((m, k) => m | (DOM_BIT[k.trim()] || 0), 0);
for (const k in UNITS) { UNITS[k].mask = maskOf(UNITS[k].hits); UNITS[k].bit = DOM_BIT[UNITS[k].dom]; }
for (const k in BUILDINGS) if (BUILDINGS[k].hits) BUILDINGS[k].mask = maskOf(BUILDINGS[k].hits);
const CAPITAL_DEF = { rate: 1.25 };
// AIがときどき建てる建物（基本の建物のほかに）
const AI_EXTRA = ['mine', 'fishery', 'ranch', 'brewery', 'storehouse', 'mint', 'stable', 'ninja', 'foundry', 'gaslab', 'port', 'airfield', 'bomberbase',
  'bunker', 'battery', 'rocket', 'aagun', 'coastgun', 'wall', 'mines', 'gasshelter', 'radar', 'trench', 'hospital', 'shrine', 'beacon', 'depot', 'temple', 'lighthouse'];

class Sim {
  /**
   * me：この端末のプレイヤーの県（1人で遊ぶとき。財布0番）。サーバーでは 0（人間は addHuman で何人でも加わる）
   * 財布：1〜47 = 各県のAI参加者たち、0 = 1人用のプレイヤー、48〜 = サーバーの人間プレイヤー
   */
  constructor(map, me, seed) {
    this.map = map;
    this.me = me;
    const S = this.S = map.scale || 1;              // 地図の細かさ（1マスの大きさが 1/S。距離の調整値を S 倍する）
    this.rng = mulberry32(seed);
    const N = map.N, W = map.W;
    this.time = 0; this.acc = 0; this.incomeT = 0;
    this.listeners = {};
    this.owner = map.initPref.slice();
    this.counts = new Int32Array(49);
    this.counts.set(map.initCounts);
    // 支配人口：各マスは「元の県の人口 ÷ 元の県のマス数」の人口を持つ（万人）
    this.cellPop = new Float64Array(48);
    // 地域を絞った地図（お試し版）では、地図にない県は最初から参加しない
    this.present = (p) => map.initCounts[p] > 0;
    for (let p = 1; p <= 47; p++) this.cellPop[p] = this.present(p) ? map.prefs[p].pop / map.initCounts[p] : 0;
    this.pop = new Float64Array(49);
    for (let p = 1; p <= 47; p++) this.pop[p] = this.present(p) ? map.prefs[p].pop : 0;
    this.popTotal = this.pop.reduce((a, b) => a + b, 0);
    this.landIdx = new Int32Array(map.landCells);
    for (let i = 0, k = 0; i < N; i++) if (map.initPref[i]) this.landIdx[k++] = i;
    // ---- 拠点（県庁・町・砦）
    this.nodes = [];
    this.capNode = new Int32Array(49).fill(-1);    // 県 → 県庁の拠点の番号
    for (let p = 1; p <= 47; p++) {
      if (!this.present(p) || map.capitalCell[p] < 0) continue;
      this.capNode[p] = this.addNode({ cell: map.capitalCell[p], pref: p, type: 'capital', name: `${map.prefs[p].name}庁（${map.prefs[p].capName}）` }).id;
    }
    for (const t of map.raw.towns) {
      const c = map.capitalCell[t.pref];
      if (t.cell < 0 || c < 0 || Math.hypot(map.X(t.cell) - map.X(c), map.Y(t.cell) - map.Y(c)) < 36 * S) continue;
      this.addNode({ cell: t.cell, pref: t.pref, type: 'town', name: t.name });
    }
    this.nodeOf = new Int16Array(N).fill(-1);
    this.nodeDist = new Uint8Array(N).fill(255);   // 拠点までの距離（255で頭打ち。メモリ節約）
    this.assignTerritory();
    this.nodeCount = new Int32Array(49);
    for (const n of this.nodes) this.nodeCount[n.owner]++;
    this.rebuildNodeCells();
    this.computeNodeAdj();
    this.nav = map.nav || (map.nav = new NavGrid(map));
    // ---- 参加者と財布（0 = プレイヤー、1..47 = 各県のAI参加者たち）
    this.humansIn = new Int32Array(49);             // 県ごとの人間の参加者数（残りをAIが担当）
    this.humans = new Map();                        // 財布 → { w, pref, name, rally, income }
    if (me) { this.humansIn[me] = 1; this.humans.set(0, { w: 0, pref: me, name: 'あなた', rally: -1, income: { food: 0, wood: 0, gold: 0 } }); }
    this.parts = new Int32Array(49);
    for (let p = 1; p <= 47; p++) this.parts[p] = this.present(p) ? Math.max(this.participantCount(p), this.humansIn[p]) : 0;
    this.res = { food: [], wood: [], gold: [] };
    for (let w = 0; w <= 47; w++) {
      const k = w === 0 ? 1 : this.aiCount(w);
      for (const r of RES_KEYS) this.res[r][w] = CONFIG.START_RES[r] * Math.max(1, k * 0.25);
    }
    // ---- 建物
    this.buildings = [];
    this.bseq = 0;
    this.bgs = 8;                                   // 建物用の格子（8マス）
    this.bgw = Math.ceil(W / this.bgs);
    this.bgrid = new Map();                         // 格子 → 建物の配列
    this.aiBuildAt = new Float64Array(48);
    for (let p = 1; p <= 47; p++) this.aiBuildAt[p] = this.rng() * 3;
    // ---- 兵士
    this.units = [];
    this.useq = 0;
    for (let p = 1; p <= 47; p++) {
      const n = Math.round(this.parts[p] * CONFIG.START_UNITS_RATIO);
      const cn = this.nodes[this.capNode[p]];
      if (cn) for (let k = 0; k < n; k++) this.spawnUnit(p, cn.x, cn.y, 20 * S, -1);
    }
    this.rally = -1;                                // プレイヤーの兵士の攻撃目標（拠点）
    this.plans = [];
    for (let p = 0; p <= 47; p++) this.plans.push({ target: -1, since: 0, defend: -1, next: this.rng() * CONFIG.AI_PLAN_INTERVAL });
    this.hs = 24;
    this.hw = Math.ceil(W / this.hs); this.hh = Math.ceil(map.H / this.hs);
    this.head = new Int32Array(this.hw * this.hh);
    this.next = new Int32Array(64);
    this.cnt = new Int32Array(49);
    this.eliminated = new Set();
    for (let p = 1; p <= 47; p++) if (!this.present(p)) this.eliminated.add(p);
    this.over = null;
    this.recent = [];
    this.stats = { captures: 0, kills: 0, built: 0, destroyed: 0, trained: 0, trainedMine: 0, paths: 0 };
    this.pathBudget = 0;
    this.income = { food: 0, wood: 0, gold: 0 };   // プレイヤーの直近の収入/秒
    this.shots = [];                                // 塔・砦の射撃（描画用）
    this.tickNo = 0;
  }
  aiCount(p) { return Math.max(0, this.parts[p] - this.humansIn[p]); }
  isHuman(w) { return w === 0 || w >= 48; }
  /** サーバー：人間の参加者を加える（財布の番号を返す）。抜けても建物と資源は残る */
  addHuman(pref, name) {
    const w = Math.max(48, this.res.food.length);
    for (const r of RES_KEYS) this.res[r][w] = CONFIG.START_RES[r];
    this.humans.set(w, { w, pref, name: name || '名無し', rally: -1, income: { food: 0, wood: 0, gold: 0 } });
    this.humansIn[pref]++;
    this.parts[pref] = Math.max(this.participantCount(pref), this.humansIn[pref]);
    return w;
  }
  prefOfWallet(w) { const h = this.humans.get(w); return h ? h.pref : w; }
  participantCount(p) {
    return Math.max(CONFIG.MIN_PARTICIPANTS, Math.round(this.map.prefs[p].pop / 100 * CONFIG.PARTICIPANTS_PER_MILLION));
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, ...a) { const l = this.listeners[ev]; if (l) for (const f of l) f(...a); }
  dispose() { this.listeners = {}; }

  // ---------------------------------------------------------- 地形・拠点
  forNeighbors(i, fn) {
    const ip = this.map.initPref;
    const lx = i & 63, ly = (i >> 6) & 63;
    if (lx > 0 && lx < 63 && ly > 0 && ly < 63) { for (let k = 0; k < 8; k++) { const j = i + OFF8[k]; if (ip[j]) fn(j); } }
    else this.map.nb8(i, (j) => { if (ip[j]) fn(j); });
    const ls = this.map.linkMap.get(i);
    if (ls) for (const j of ls) fn(j);
  }
  /** マス i の持ち主を from → to に（領土マス数と支配人口を更新） */
  moveCell(i, from, to) {
    const w = this.cellPop[this.map.initPref[i]];
    this.counts[from]--; this.counts[to]++;
    this.pop[from] -= w; this.pop[to] += w;
    this.owner[i] = to;
  }
  cellAt(x, y) { return this.map.id(x | 0, y | 0); }
  addNode(o) {
    const n = { id: this.nodes.length, cell: o.cell, x: this.map.X(o.cell) + 0.5, y: this.map.Y(o.cell) + 0.5, pref: o.pref,
      owner: o.owner || o.pref, type: o.type, name: o.name, progress: 0, capBy: 0, capturedAt: -1e9, attackers: 0, defenders: 0,
      byPlayer: !!o.byPlayer, wallet: o.wallet === undefined ? -1 : o.wallet };
    this.nodes.push(n);
    return n;
  }
  assignTerritory() {
    const ip = this.map.initPref, nodeOf = this.nodeOf, dist = this.nodeDist, map = this.map;
    const q = new Int32Array(this.map.landCells + this.nodes.length);
    let qh = 0, qt = 0;
    for (const n of this.nodes) { nodeOf[n.cell] = n.id; dist[n.cell] = 0; q[qt++] = n.cell; }
    while (qh < qt) {
      const i = q[qh++], nid = nodeOf[i], P = this.nodes[nid].pref, d = dist[i] + 1;
      this.forNeighbors(i, (j) => { if (nodeOf[j] === -1 && ip[j] === P) { nodeOf[j] = nid; dist[j] = d > 255 ? 255 : d; q[qt++] = j; } });
    }
    for (const i of this.landIdx) {
      if (nodeOf[i] !== -1) continue;
      let best = -1, bd = 1e9;
      for (const n of this.nodes) {
        if (n.pref !== ip[i]) continue;
        const d = Math.hypot(n.x - map.X(i), n.y - map.Y(i));
        if (d < bd) { bd = d; best = n.id; }
      }
      nodeOf[i] = best; dist[i] = Math.min(255, Math.round(bd));
    }
  }
  rebuildNodeCells() {
    const n = this.nodes.length, cnt = new Int32Array(n + 1);
    for (const i of this.landIdx) cnt[this.nodeOf[i] + 1]++;
    for (let k = 1; k <= n; k++) cnt[k] += cnt[k - 1];
    const flat = new Int32Array(this.landIdx.length), pos = cnt.slice();
    for (const i of this.landIdx) flat[pos[this.nodeOf[i]]++] = i;
    this.nodeCells = [];
    for (let k = 0; k < n; k++) this.nodeCells.push(flat.subarray(cnt[k], cnt[k + 1]));
  }
  computeNodeAdj() {
    const adj = this.nodes.map(() => new Set());
    const nodeOf = this.nodeOf, map = this.map, ip = map.initPref;
    for (const i of this.landIdx) {
      const a = nodeOf[i], x = map.X(i), y = map.Y(i);
      for (const j of [map.id(x + 1, y), map.id(x, y + 1), map.id(x + 1, y + 1), map.id(x - 1, y + 1)]) {
        if (j < 0 || !ip[j]) continue;
        const b = nodeOf[j];
        if (a !== b) { adj[a].add(b); adj[b].add(a); }
      }
      const ls = this.map.linkMap.get(i);
      if (ls) for (const j of ls) { const b = nodeOf[j]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
    }
    this.nodeAdj = adj.map((s) => [...s]);
  }
  /** 占領に必要な量（近くに味方の寺があれば1.5倍。10秒ごとに確かめる） */
  needFor(n) {
    const base = CONFIG.CAPTURE_NEED[n.type] || CONFIG.CAPTURE_NEED.fort;
    if (!this.buildingsNear) return base;
    if (this.time >= (n.holdAt || 0)) {
      n.holdAt = this.time + 10; n.hold = 1;
      this.buildingsNear(n.x, n.y, 20, (b) => { const a = BUILDINGS[b.type].aura; if (a && a.hold && b.owner === n.owner) n.hold = a.hold; });
    }
    return base * (n.hold || 1);
  }
  cellsOf(id) {
    const list = this.nodeCells[id], nodeOf = this.nodeOf;
    let stale = 0;
    for (let k = 0; k < list.length; k++) if (nodeOf[list[k]] !== id) stale++;
    if (!stale) return list;
    const out = new Int32Array(list.length - stale);
    for (let k = 0, j = 0; k < list.length; k++) if (nodeOf[list[k]] === id) out[j++] = list[k];
    this.nodeCells[id] = out;
    return out;
  }
  isRecent(i) { const n = this.nodes[this.nodeOf[i]]; return n && this.time - n.capturedAt < CONFIG.RECENT_HATCH; }

  // ---------------------------------------------------------- 進行
  /** 実時間 dt 秒ぶん進める。speed>1 は早送り（確認用）：刻みを長くして回数を抑える */
  update(dt, speed = 1) {
    if (this.over) return;
    const tick = Math.min(CONFIG.TICK * Math.max(1, speed / 8), CONFIG.MAX_TICK);
    this.acc += dt * speed;
    let steps = 0;
    while (this.acc >= tick && steps < 8 && !this.over) { this.step(tick); this.acc -= tick; steps++; }
    if (steps >= 8) this.acc = 0;
    this.lastTick = tick;
  }
  step(dt) {
    this.time += dt;
    this.pathBudget = CONFIG.PATH_BUDGET;
    this.incomeT += dt;
    if (this.incomeT >= 1) { const s = Math.floor(this.incomeT); this.incomeT -= s; this.produce(s); }   // 刻みが1秒より長くても収入を取りこぼさない
    this.buildHash();
    this.planAll();
    this.aiBuildAll();
    this.trainAll(dt);
    this.thinkAll();
    this.combat(dt);
    this.moveAll(dt);
    this.updateNodes(dt);
    this.updateRecent();
    if (this.time >= CONFIG.SEASON_DAYS * 86400) this.checkEnd();
    // 倒れた兵士は片付ける（兵舎から補充される）。空間ハッシュの番号がずれないよう、刻みの最後に行う
    if (this.units.some((u) => !u.alive)) this.units = this.units.filter((u) => u.alive);
  }

  // ---------------------------------------------------------- 資源
  near(c, r, fn) {
    const map = this.map, x0 = map.X(c), y0 = map.Y(c), st = Math.max(1, this.S);
    for (let dy = -r; dy <= r; dy += st) for (let dx = -r; dx <= r; dx += st) if (fn(map.id(x0 + dx, y0 + dy))) return true;
    return false;
  }
  canAfford(w, cost) { if (this.isFree(w)) return true; for (const r of RES_KEYS) if ((cost[r] || 0) > this.res[r][w]) return false; return true; }
  pay(w, cost) { if (this.isFree(w)) return; for (const r of RES_KEYS) this.res[r][w] -= cost[r] || 0; }
  forestNear(c, r) {
    const map = this.map, x0 = map.X(c), y0 = map.Y(c), t = map.terrain;
    let n = 0;
    for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
      const i = map.id(x0 + dx, y0 + dy);
      if (i >= 0 && (t[i] & 7) === 2) n++;
    }
    return n;
  }
  /** 毎秒：基本収入（参加者数ぶん）＋拠点＋建物 */
  produce(sec) {
    const add = (w, r, v) => { this.res[r][w] += v * sec; };
    const H = this.humans;
    for (const h of H.values()) h.income = { food: 0, wood: 0, gold: 0 };
    const inc = (w, r, v) => { this.res[r][w] += v * sec; if (w === 0 || w >= 48) { const h = H.get(w); if (h) h.income[r] += v; } };
    for (let p = 1; p <= 47; p++) {
      if (!this.nodeCount[p]) continue;
      const k = this.aiCount(p);
      if (k) for (const r of RES_KEYS) add(p, r, CONFIG.BASE_INCOME[r] * k);
    }
    for (const h of H.values()) if (this.nodeCount[h.pref]) for (const r of RES_KEYS) inc(h.w, r, CONFIG.BASE_INCOME[r]);
    for (const n of this.nodes) {
      const mk = n.type === 'capital' ? CONFIG.CAPITAL_MAKE : n.type === 'town' ? BUILDINGS.town.make : null;
      if (!mk) continue;
      const w = n.wallet >= 0 && this.prefOfWallet(n.wallet) === n.owner ? n.wallet : n.owner;
      for (const r in mk) inc(w, r, mk[r]);
    }
    for (const b of this.buildings) {
      const def = BUILDINGS[b.type];
      if (def.cat === 'eco' && this.time >= (b.ecoAt || 0)) {   // 蔵の近くは生産が増える（1分ごとに確かめる）
        b.ecoAt = this.time + 60; b.eco = 1;
        this.buildingsNear(b.x, b.y, 10, (o) => { const a = BUILDINGS[o.type].aura; if (a && a.eco && o.owner === b.owner) b.eco = a.eco; });
      }
      const em = b.eco || 1;
      if (def.make) for (const r in def.make) inc(b.wallet, r, def.make[r] * b.mul * em);
      if (def.forest) inc(b.wallet, 'wood', Math.min(CONFIG.LUMBER_MAX, b.forest * CONFIG.LUMBER_PER_FOREST));
    }
    const me0 = H.get(0);
    this.income = me0 ? me0.income : { food: 0, wood: 0, gold: 0 };
  }

  // ---------------------------------------------------------- 建物
  bkey(x, y) { return ((y / this.bgs) | 0) * this.bgw + ((x / this.bgs) | 0); }
  buildingsNear(x, y, r, fn) {
    const g = this.bgs;
    for (let by = ((y - r) / g) | 0; by <= ((y + r) / g) | 0; by++) for (let bx = ((x - r) / g) | 0; bx <= ((x + r) / g) | 0; bx++) {
      const list = this.bgrid.get(by * this.bgw + bx);
      if (list) for (const b of list) { const d = Math.hypot(b.x - x, b.y - y); if (d <= r) fn(b, d); }
    }
  }
  /** 建てられるか（null なら可。理由の文字列を返す） */
  canBuild(type, P, c, w) {
    const def = BUILDINGS[type], map = this.map;
    if (c < 0 || c >= map.N || !map.initPref[c]) return 'sea';
    if (this.owner[c] !== P) return 'notown';
    const x = map.X(c) + 0.5, y = map.Y(c) + 0.5, t = map.terrain[c] & 7;
    let blocked = false;
    this.buildingsNear(x, y, CONFIG.BUILD_GAP, () => { blocked = true; });
    if (blocked) return 'crowded';
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < (def.node ? CONFIG.NODE_MIN_DIST * this.S : CONFIG.BUILD_GAP + 1)) return def.node ? 'nearnode' : 'crowded';
    }
    if (type === 'farm' && t === 3) return 'terrain';
    if (type === 'lumber' && this.forestNear(c, 6) < CONFIG.LUMBER_MIN_FOREST) return 'noforest';
    if (def.need === 'plain' && t !== 1) return 'terrain';
    if (def.need === 'mountain' && !this.near(c, 5 * this.S, (i) => (map.terrain[i] & 7) === 3)) return 'nomountain';
    if (def.need === 'coast' && !this.near(c, 5 * this.S, (i) => i < 0 || !map.initPref[i])) return 'nocoast';
    if (!this.canAfford(w, def.cost)) return 'cost';
    return null;
  }
  /** P の県の財布 w（AIは w=P）で建てる */
  build(type, P, c, w) {
    if (w === true) w = 0; else if (w === false || w === undefined) w = P;
    const byPlayer = this.isHuman(w);
    const why = this.canBuild(type, P, c, w);
    if (why) return { ok: false, why };
    const def = BUILDINGS[type];
    this.pay(w, def.cost);
    this.stats.built++;
    if (def.node) {
      const n = this.buildNode(P, c, type, w);
      this.emit('built', { node: n, type, by: P, byPlayer, wallet: w });
      return { ok: true, node: n };
    }
    const b = { id: ++this.bseq, type, cell: c, x: this.map.X(c) + 0.5, y: this.map.Y(c) + 0.5, owner: P, wallet: w, byPlayer,
      hp: def.hp, maxHp: def.hp, t: 0, rot: (this.rng() * 4 | 0) * Math.PI / 2, forest: def.forest ? this.forestNear(c, 6) : 0,
      mul: type === 'farm' && (this.map.terrain[c] & 7) === 2 ? 0.5 : 1 };   // 森を切り開いた農場は収穫が半分
    this.buildings.push(b);
    const k = this.bkey(b.x, b.y);
    if (!this.bgrid.has(k)) this.bgrid.set(k, []);
    this.bgrid.get(k).push(b);
    this.emit('built', { building: b, type, by: P, byPlayer, wallet: w });
    return { ok: true, building: b };
  }
  removeBuilding(b) {
    const k = this.bkey(b.x, b.y), list = this.bgrid.get(k);
    if (list) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); }
    const i = this.buildings.indexOf(b);
    if (i >= 0) this.buildings.splice(i, 1);
    b.dead = true;
    this.stats.destroyed++;
    this.emit('destroyed', b);
  }
  /** 町・砦：周りのマスのうち、今の持ち主の拠点より近いマスを自分の領土にする（国境を押し出す） */
  buildNode(P, c, type, w) {
    const k = this.nodes.filter((n) => n.type === type && n.pref === P).length + 1;
    const byPlayer = this.isHuman(w);
    const n = this.addNode({ cell: c, pref: P, owner: P, type, name: `${this.map.prefs[P].short}の${BUILDINGS[type].name}${k}`, byPlayer, wallet: byPlayer ? w : -1 });
    this.nodeCount[P]++;
    const nodeOf = this.nodeOf, dist = this.nodeDist;
    const changed = [], claimed = [];
    const q = [c], d = new Map([[c, 0]]);
    const take = (i, di) => {
      nodeOf[i] = n.id; dist[i] = di; claimed.push(i);
      if (this.owner[i] !== P) { this.moveCell(i, this.owner[i], P); changed.push(i); }
    };
    take(c, 0);
    for (let qh = 0; qh < q.length; qh++) {
      const i = q[qh], di = d.get(i) + 1;
      if (di > CONFIG.NODE_RADIUS * this.S * (BUILDINGS[type].radius || 1)) continue;
      this.forNeighbors(i, (j) => {
        if (d.has(j) || dist[j] === 0 || di >= dist[j]) return;
        d.set(j, di); q.push(j); take(j, di);
      });
    }
    this.nodeCells.push(Int32Array.from(claimed));
    this.nodeAdj.push([]);
    const adj = new Set();
    for (const i of claimed) this.forNeighbors(i, (j) => { const b = nodeOf[j]; if (b !== n.id) adj.add(b); });
    for (const b of adj) { this.nodeAdj[n.id].push(b); if (!this.nodeAdj[b].includes(n.id)) this.nodeAdj[b].push(n.id); }
    this.flipBuildings(changed, P);
    this.emit('cells', changed);
    this.checkEnd();
    return n;
  }
  /** 持ち主が変わったマスにある建物は、新しい持ち主のものになる */
  flipBuildings(cells, P) {
    if (!cells.length || !this.buildings.length) return;
    for (const b of this.buildings) {
      if (b.owner === P || this.owner[b.cell] !== P) continue;
      const old = b.owner;
      b.owner = P; b.wallet = P; b.byPlayer = false; b.t = 0;
      this.emit('flipped', { building: b, from: old, to: P });
    }
  }

  // ---------------------------------------------------------- 兵士
  /** hw：人間の財布（兵舎の持ち主。AIの兵は -1）・type：兵種（UNITS） */
  spawnUnit(P, x, y, r, hw, type = 'ashigaru') {
    if (hw === true) hw = 0; else if (hw === false || hw === undefined) hw = -1;
    const fromPlayer = hw >= 0, def = UNITS[type];
    let px = x, py = y, found = def.dom !== 'land';
    for (let k = 0; k < 24 && def.dom !== 'air'; k++) {
      const rr = def.dom === 'sea' ? r + k * this.S : r;
      const tx = x + (this.rng() * 2 - 1) * rr, ty = y + (this.rng() * 2 - 1) * rr;
      const ok = def.dom === 'sea' ? this.isSea(tx, ty) : this.owner[this.cellAt(tx, ty)] === P;
      if (ok) { px = tx; py = ty; found = true; break; }
      if (def.dom === 'sea') found = false;
    }
    if (def.dom === 'sea' && !found) return null;   // 近くに海がない
    const u = { id: this.useq++, pref: P, fromPlayer, hw, type, bit: def.bit, stealth: !!def.stealth,
      role: this.rng() < CONFIG.AI_DEFENDER_RATIO ? 'def' : 'atk',
      x: px, y: py, px, py, hp: def.hp, alive: true, path: null, pi: 0, dest: null, goalNode: -1, chase: -1, engaged: -1, hitB: null,
      thinkAt: this.time + this.rng(), offX: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2, offY: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2,
      fuel: def.fuel || 0, cd: 0, bombs: 0 };
    if (fromPlayer || def.dom !== 'land' || type === 'cannon' || type === 'gas' || type === 'ninja') u.role = 'atk';
    this.units.push(u);
    return u;
  }
  isSea(x, y) { const i = this.cellAt(x, y); return i < 0 || !this.map.initPref[i]; }
  unitCap(P) { return Math.floor(this.parts[P] * CONFIG.UNIT_CAP_PER_PARTICIPANT + this.nodeCount[P] * CONFIG.UNIT_CAP_PER_NODE + (this.capPlus ? this.capPlus[P] : 0)); }
  unitCount(P) { let n = 0; for (const u of this.units) if (u.pref === P) n++; return n; }
  isFree(w) { return CONFIG.FREE_HUMANS && this.isHuman(w); }
  trainAll(dt) {
    const cnt = new Int32Array(49), tc = new Map();
    for (const u of this.units) { cnt[u.pref]++; const k = u.pref * 16 + (u.bit || 1); tc.set(k, (tc.get(k) || 0) + 1); }
    const plus = this.capPlus = new Int32Array(49);
    for (const b of this.buildings) if (BUILDINGS[b.type].capPlus) plus[b.owner] += BUILDINGS[b.type].capPlus;
    for (const b of this.buildings) {
      const def = BUILDINGS[b.type];
      if (!def.unit) continue;
      b.t += dt;
      const need = def.train * (CONFIG.TRAIN_MULT || 1);
      if (b.t < need) continue;
      const free = this.isFree(b.wallet);
      // 軍艦は兵の上限の15%まで、飛行機は12%まで（陸の兵がいなくならないように）
      const bit = UNITS[def.unit].bit, share = bit === 2 ? 0.15 : bit === 4 ? 0.12 : 1;
      if (share < 1 && (tc.get(b.owner * 16 + bit) || 0) >= Math.max(2, this.unitCap(b.owner) * share)) { b.t = need; continue; }
      if (cnt[b.owner] >= this.unitCap(b.owner) || (!free && this.res.food[b.wallet] < def.trainFood)) { b.t = need; continue; }
      const u = this.spawnUnit(b.owner, b.x, b.y, def.unit === 'ship' ? 3 * this.S : 2.5, this.isHuman(b.wallet) ? b.wallet : -1, def.unit);
      b.t = 0;
      if (!u) continue;
      if (!free) this.res.food[b.wallet] -= def.trainFood;
      cnt[b.owner]++; tc.set(b.owner * 16 + bit, (tc.get(b.owner * 16 + bit) || 0) + 1);
      this.stats.trained++;
      if (b.wallet === 0) this.stats.trainedMine++;
    }
  }
  buildHash() {
    this.head.fill(-1);
    if (this.next.length < this.units.length) this.next = new Int32Array(this.units.length * 2);
    const hs = this.hs, hw = this.hw;
    for (let k = 0; k < this.units.length; k++) {
      const u = this.units[k];
      const b = ((u.y / hs) | 0) * hw + ((u.x / hs) | 0);
      this.next[k] = this.head[b];
      this.head[b] = k;
    }
  }
  forUnitsNear(x, y, r, fn) {
    const hs = this.hs, r2 = r * r;
    const bx0 = Math.max(0, ((x - r) / hs) | 0), bx1 = Math.min(this.hw - 1, ((x + r) / hs) | 0);
    const by0 = Math.max(0, ((y - r) / hs) | 0), by1 = Math.min(this.hh - 1, ((y + r) / hs) | 0);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      for (let k = this.head[by * this.hw + bx]; k >= 0; k = this.next[k]) {
        const v = this.units[k];
        if (!v || !v.alive) continue;
        const dx = v.x - x, dy = v.y - y, d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(v, d2);
      }
    }
  }
  /** mask：狙える相手（1=陸 2=海 4=空）。see=false なら忍者は見えない（敵のレーダーの近くは別） */
  nearestEnemy(x, y, P, r, mask = 1, see = true) {
    let best = null, bd = 1e9;
    this.forUnitsNear(x, y, r, (v, d2) => {
      if (v.pref === P || !(v.bit & mask) || d2 >= bd) return;
      if (!see && v.stealth && !(v.buff && v.buff.det)) return;
      bd = d2; best = v;
    });
    return best;
  }

  // ---------------------------------------------------------- AI（県ごとの作戦・建築）
  planAll() {
    for (let p = 1; p <= 47; p++) {
      const pl = this.plans[p];
      if (this.time < pl.next || this.nodeCount[p] === 0) continue;
      pl.next = this.time + CONFIG.AI_PLAN_INTERVAL;
      this.plan(p, pl);
    }
  }
  plan(P, pl) {
    // 役割の割合を保つ：攻撃担当は倒れやすいので、放っておくと守備担当ばかりになり攻めなくなる
    let nd = 0, na = 0;
    for (const u of this.units) if (u.pref === P && !u.fromPlayer) { if (u.role === 'def') nd++; else na++; }
    const want = Math.round((nd + na) * CONFIG.AI_DEFENDER_RATIO);
    if (nd !== want) {
      for (const u of this.units) {
        if (u.pref !== P || u.fromPlayer || nd === want) continue;
        if (nd > want && u.role === 'def') { u.role = 'atk'; u.goalNode = -1; u.home = -1; nd--; }
        else if (nd < want && u.role === 'atk' && u.engaged < 0) { u.role = 'def'; u.goalNode = -1; nd++; }
      }
    }
    let defend = -1, ds = 0;
    for (const n of this.nodes) {
      if (n.owner !== P || !n.attackers) continue;
      const s = n.progress / this.needFor(n) + n.attackers * 0.05 + (n.type === 'capital' ? 0.5 : 0);
      if (s > ds) { ds = s; defend = n.id; }
    }
    pl.defend = defend;
    const cur = this.nodes[pl.target];
    if (!cur || cur.owner === P || this.time - pl.since > CONFIG.AI_TARGET_TIMEOUT) {
      let sx = 0, sy = 0, k = 0;
      for (const u of this.units) if (u.pref === P) { sx += u.x; sy += u.y; k++; }
      const cap = this.nodes[this.capNode[P]] || this.nodes.find((n) => n.owner === P);
      const cx = k ? sx / k : cap.x, cy = k ? sy / k : cap.y;
      let best = -1, bs = -1e9;
      const seen = new Set();
      for (const n of this.nodes) {
        if (n.owner !== P) continue;
        for (const a of this.nodeAdj[n.id]) {
          const e = this.nodes[a];
          if (e.owner === P || seen.has(a)) continue;
          seen.add(a);
          const s = this.rng() * 1.5 - e.defenders * 0.4 - Math.hypot(e.x - cx, e.y - cy) / (120 * this.S)
            + (e.type === 'capital' ? 0.8 : 0) + (e.type === 'fort' ? 0.3 : 0);
          if (s > bs) { bs = s; best = a; }
        }
      }
      pl.target = best; pl.since = this.time;
    }
  }
  /** 県のAI参加者たちの建築。参加者が多いほど頻繁に建てる */
  aiBuildAll() {
    for (let p = 1; p <= 47; p++) {
      if (this.time < this.aiBuildAt[p] || !this.nodeCount[p]) continue;
      const k = this.aiCount(p);
      if (!k) { this.aiBuildAt[p] = this.time + 600; continue; }
      this.aiBuildAt[p] = this.time + CONFIG.AI_BUILD_INTERVAL * 10 / k * (0.6 + this.rng() * 0.8);
      this.aiBuild(p, k);
    }
  }
  aiBuild(P, k) {
    const mine = { farm: 0, lumber: 0, market: 0, barracks: 0, tower: 0 };
    let total = 0;
    for (const b of this.buildings) if (b.owner === P && b.wallet === P) { mine[b.type] = (mine[b.type] || 0) + 1; total++; }
    if (total >= k * CONFIG.MAX_BUILDINGS_PER_PARTICIPANT) return;
    const nodes = this.nodeCount[P];
    const want = [];
    if (mine.farm < 2 + nodes * 1.5) want.push('farm');
    if (mine.lumber < 1 + nodes) want.push('lumber');
    if (mine.barracks < 1 + nodes / 3) want.push('barracks');
    if (mine.market < nodes / 2) want.push('market');
    if (mine.tower < nodes / 2) want.push('tower');
    // 町・砦（国境を広げる）はときどき。県の参加者数に応じた上限まで
    if (nodes < 6 + k * 0.5 && this.rng() < 0.1) { const r = this.rng(); want.push(r < 0.5 ? 'town' : r < 0.85 ? 'fort' : 'castle'); }
    // 基本がそろったら、いろいろな建物（兵の生産・防衛・支援）も建てる
    if (!want.length || this.rng() < 0.45) want.length = 0, want.push(AI_EXTRA[(this.rng() * AI_EXTRA.length) | 0]);
    const type = want[(this.rng() * want.length) | 0];
    if (!this.canAfford(P, BUILDINGS[type].cost)) return;
    const c = this.findSite(type, P, P);
    if (c >= 0) this.build(type, P, c, false);
  }
  /** 建てる場所を探す：自県の拠点の周り（塔・砦・町は敵に近い拠点の周り） */
  findSite(type, P, w) {
    const own = this.nodes.filter((n) => n.owner === P);
    if (!own.length) return -1;
    const front = (type === 'tower' || BUILDINGS[type].node)
      ? own.filter((n) => this.nodeAdj[n.id].some((a) => this.nodes[a].owner !== P)) : own;
    const list = front.length ? front : own;
    for (let tries = 0; tries < (BUILDINGS[type].need ? 30 : 14); tries++) {
      const n = list[(this.rng() * list.length) | 0];
      const S = this.S, r = BUILDINGS[type].node ? (CONFIG.NODE_MIN_DIST + this.rng() * 15) * S : (3 + this.rng() * 20) * S;
      const a = this.rng() * Math.PI * 2;
      let x = n.x + Math.cos(a) * r, y = n.y + Math.sin(a) * r;
      if (BUILDINGS[type].node && pl0(this, P)) {
        // 攻め先の方向へ寄せる
        const t = this.nodes[this.plans[P].target];
        if (t) { const L = Math.hypot(t.x - n.x, t.y - n.y) || 1; x = n.x + (t.x - n.x) / L * r; y = n.y + (t.y - n.y) / L * r; }
      }
      const c = this.cellAt(x, y);
      if (!this.canBuild(type, P, c, w)) return c;
    }
    return -1;
  }
  thinkAll() {
    for (const u of this.units) {
      if (!u.alive) continue;
      if (this.time >= (u.buffAt || 0)) this.updateBuff(u);
      if (this.time < u.thinkAt) continue;
      u.thinkAt = this.time + CONFIG.THINK_INTERVAL * (0.8 + this.rng() * 0.6);
      this.think(u);
    }
  }
  /** 周りの建物からの効果（2秒ごとに計算して覚えておく）：足・攻撃・回復・毒ガスへの強さ・被害・軍艦・見つかったか */
  updateBuff(u) {
    u.buffAt = this.time + 2;
    const f = { spd: 1, dps: 1, heal: 0, gasRes: 1, armor: 1, navy: 1, det: false };
    this.buildingsNear(u.x, u.y, 25, (b, d) => {
      const a = BUILDINGS[b.type].aura;
      if (!a || d > a.r) return;
      if (b.owner === u.pref) {
        if (a.spd) f.spd = Math.max(f.spd, a.spd);
        if (a.dps) f.dps = Math.max(f.dps, a.dps);
        if (a.heal) f.heal = Math.max(f.heal, a.heal);
        if (a.gasRes) f.gasRes = Math.min(f.gasRes, a.gasRes);
        if (a.armor && u.bit === 1) f.armor = Math.min(f.armor, a.armor);
        if (a.navy && u.bit === 2) f.navy = Math.max(f.navy, a.navy);
      } else {
        if (a.enemySlow && u.bit === 1) f.spd *= a.enemySlow;
        if (a.detect) f.det = true;
      }
    });
    u.buff = f;
  }
  think(u) {
    const def = UNITS[u.type], S = this.S;
    if (def.mask) {
      const e = this.nearestEnemy(u.x, u.y, u.pref, CONFIG.AGGRO_RANGE * S * (def.dom === 'air' ? 3 : 1), def.mask, true);
      if (e && u.type !== 'bomber') { u.chase = e.id; return; }
    }
    u.chase = -1;
    const pl = this.plans[u.pref];
    let node = -1;
    const rally = u.fromPlayer ? this.rallyOf(u.hw) : -1;
    if (rally >= 0 && this.nodes[rally].owner !== u.pref) node = rally;
    else if (u.role === 'def') {
      // 持ち場は一度決めたら固定（自県の拠点でなくなったとき・前線でなくなったときだけ選び直す）
      const h = this.nodes[u.home];
      if (!h || h.owner !== u.pref || (this.time - (u.homeAt || 0) > 3600)) { u.home = this.homeNode(u); u.homeAt = this.time; }
      node = pl.defend >= 0 ? pl.defend : u.home;
    }
    else node = pl.target >= 0 ? pl.target : (pl.defend >= 0 ? pl.defend : -1);
    if (node < 0) return;
    if (u.goalNode === node && (u.path || u.dest)) return;
    const n = this.nodes[node];
    if (def.dom === 'air') { u.dest = [n.x + u.offX * 0.3, n.y + u.offY * 0.3]; u.path = null; u.goalNode = node; return; }
    if (def.dom === 'sea') {
      const p = this.seaPointNear(n);
      if (!p) { u.thinkAt = this.time + 30; return; }
      u.dest = [p[0] + u.offX * 0.5, p[1] + u.offY * 0.5]; u.path = null; u.goalNode = node; u.stuck = 0; return;
    }
    if (!this.setDest(u, n.x + u.offX, n.y + u.offY)) { u.thinkAt = this.time + 0.3; return; }
    u.goalNode = node;
  }
  /** 拠点の近くの海の位置（軍艦の目的地）。一度探したら覚えておく */
  seaPointNear(n) {
    if (n.seaPt !== undefined) return n.seaPt;
    let best = null;
    const S = this.S;
    for (let r = 4 * S; r <= 60 * S && !best; r += 3 * S) {
      for (let k = 0; k < 24; k++) {
        const a = k / 24 * Math.PI * 2, x = n.x + Math.cos(a) * r, y = n.y + Math.sin(a) * r;
        if (this.isSea(x, y) && this.isSea(x + 2 * S, y) && this.isSea(x - 2 * S, y) && this.isSea(x, y + 2 * S) && this.isSea(x, y - 2 * S)) { best = [x, y]; break; }
      }
    }
    n.seaPt = best;
    return best;
  }
  homeNode(u) {
    let best = -1, bd = 1e9;
    for (const n of this.nodes) {
      if (n.owner !== u.pref) continue;
      if (!this.nodeAdj[n.id].some((a) => this.nodes[a].owner !== u.pref)) continue;
      const d = Math.hypot(n.x - u.x, n.y - u.y);
      if (d < bd) { bd = d; best = n.id; }
    }
    return best;
  }
  setDest(u, x, y) {
    if (this.pathBudget <= 0) return false;
    this.pathBudget--;
    this.stats.paths++;
    const path = this.nav.find(u.x, u.y, x, y);
    u.path = path || [];
    u.pi = 0;
    u.dest = [x, y];
    return true;
  }
  unitById(id) { return this.unitIndex ? this.unitIndex.get(id) : null; }

  // ---------------------------------------------------------- 戦闘・移動
  /** 爆発（砲撃・爆弾・地雷）：半径 r の中の敵の兵（陸・海）と建物に被害 */
  boom(x, y, r, dmg, P, hitB, kind) {
    this.forUnitsNear(x, y, r, (v) => { if (v.pref !== P && v.bit !== 4) this.hitUnit(v, dmg); });
    if (hitB) this.buildingsNear(x, y, r, (b) => { if (b.owner !== P) { b.hp -= hitB; b.hitAt = this.time; } });
    if (this.booms.length < 200) this.booms.push([x, y, r, this.time, kind || 0]);
  }
  hitUnit(v, a) { this.dmg[v.k] += a * (v.buff ? v.buff.armor : 1); }
  combat(dt) {
    this.unitIndex = new Map();
    const U = this.units, S = this.S;
    if (!this.dmg || this.dmg.length < U.length) this.dmg = new Float32Array(U.length * 2);
    const dmg = this.dmg;
    for (let k = 0; k < U.length; k++) { U[k].k = k; dmg[k] = 0; this.unitIndex.set(U[k].id, U[k]); }
    if (!this.booms) this.booms = [];
    if (!this.gas) this.gas = [];
    this.booms = this.booms.filter((b) => this.time - b[3] < 1.5);
    for (const u of U) {
      if (!u.alive) continue;
      const def = UNITS[u.type], buff = u.buff || {};
      u.engaged = -1; u.hitB = null;
      u.cd -= dt;
      if (def.bomb) {   // 爆撃機：目標の拠点の上で爆弾を落とす
        const n = this.nodes[u.goalNode];
        if (n && n.owner !== u.pref && Math.hypot(n.x - u.x, n.y - u.y) < 4 * S && u.cd <= 0) {
          u.cd = def.bomb.every; u.bombs++;
          this.boom(u.x + (this.rng() - 0.5) * 3, u.y + (this.rng() - 0.5) * 3, def.bomb.r, def.bomb.dmg, u.pref, def.bomb.dmg * 1.5, 1);
          if (u.bombs >= 6) u.fuel = 0;
        }
        continue;
      }
      if (!def.mask) continue;
      const e = this.nearestEnemy(u.x, u.y, u.pref, def.range, def.mask, true);
      const onHome = u.bit === 1 && this.owner[this.cellAt(u.x, u.y)] === u.pref;
      const mult = (onHome ? CONFIG.HOME_BONUS : 1) * (buff.dps || 1) * (buff.navy || 1);
      if (e) {
        u.engaged = e.id;
        if (def.gas) {   // 毒ガス兵：敵の位置に毒ガスを撒く
          if (u.cd <= 0) { u.cd = def.gas.every; if (this.gas.length < 400) this.gas.push({ x: e.x, y: e.y, r: def.gas.r, dps: def.gas.dps, until: this.time + def.gas.life, P: u.pref }); }
          this.hitUnit(e, def.dps * dt * mult);
        } else if (def.splash) {
          if (u.cd <= 0) { u.cd = 2; this.boom(e.x, e.y, def.splash, def.dps * 2 * mult, u.pref, def.dps * 2 * def.vsB * CONFIG.BUILDING_DPS_MULT, 0); }
        } else this.hitUnit(e, def.dps * dt * mult * (e.bit === 1 && u.bit === 4 ? 0.5 : 1));
        continue;
      }
      // 敵兵がいなければ、近くの敵の建物を壊す（飛行機は建物を撃たない＝爆撃機の役目）
      if (!def.vsB || u.bit === 4) continue;
      let tb = null, bd = 1e9;
      this.buildingsNear(u.x, u.y, def.range + 1.2, (b, d) => { if (b.owner !== u.pref && d < bd) { bd = d; tb = b; } });
      if (tb) {
        if (def.splash) { if (u.cd <= 0) { u.cd = 2; this.boom(tb.x, tb.y, def.splash, def.dps * 2 * mult, u.pref, def.dps * 2 * def.vsB * CONFIG.BUILDING_DPS_MULT, 0); } }
        else { tb.hp -= def.dps * def.vsB * CONFIG.BUILDING_DPS_MULT * dt * mult; tb.hitAt = this.time; }
        u.hitB = tb;
      }
    }
    // 毒ガス：雲の中の敵の陸の兵に被害（防毒壕の近くは1/5）
    if (this.gas.length) {
      this.gas = this.gas.filter((c) => c.until > this.time);
      for (const c of this.gas) this.forUnitsNear(c.x, c.y, c.r, (v) => { if (v.pref !== c.P && v.bit === 1) dmg[v.k] += c.dps * dt * (v.buff ? v.buff.gasRes : 1); });
    }
    // 建物と拠点が撃つ（それぞれ決まった間隔でまとめて撃つ）
    this.tickNo = (this.tickNo || 0) + 1;
    if (this.tickNo % 5 === 0) this.shots = [];
    const shoot = (o, x, y, P, def, range, dps, mask) => {
      o.cd = (o.cd || 0) - dt;
      if (o.cd > 0) return;
      const rate = def.rate || 1.25;
      o.cd = rate;
      let mul = 1;
      if (mask === 4) this.buildingsNear(x, y, 25, (r) => { const a = BUILDINGS[r.type].aura; if (a && a.aa && r.owner === P) mul = a.aa; });
      const e = this.nearestEnemy(x, y, P, range, mask, false);
      if (!e) return;
      if (def.splash) this.boom(e.x, e.y, def.splash, dps * rate * mul, P, dps * rate * 0.5, 0);
      else this.hitUnit(e, dps * rate * mul);
      if (this.shots.length < 300) this.shots.push([x, y, e.x, e.y]);
    };
    for (const b of this.buildings) {
      const def = BUILDINGS[b.type];
      if (def.dps) shoot(b, b.x, b.y, b.owner, def, def.range, def.dps, def.mask);
      else if (def.mine) {   // 地雷原
        b.cd = (b.cd || 0) - dt;
        if (b.cd <= 0 && this.nearestEnemy(b.x, b.y, b.owner, def.mine.r, 1, true)) { b.cd = def.mine.every; this.boom(b.x, b.y, def.mine.r, def.mine.dmg, b.owner, 0, 2); }
      }
    }
    for (const n of this.nodes) {
      if (n.type === 'capital') shoot(n, n.x, n.y, n.owner, CAPITAL_DEF, CONFIG.CAPITAL_RANGE, CONFIG.CAPITAL_DPS, 1);
      else if (BUILDINGS[n.type].dps) { const d = BUILDINGS[n.type]; shoot(n, n.x, n.y, n.owner, d, d.range, d.dps, d.mask); }
    }
    for (const u of U) {
      if (!u.alive) continue;
      const def = UNITS[u.type];
      const got = dmg[u.k];
      u.hp -= got;
      if (u.bit === 1) {
        const own = this.owner[this.cellAt(u.x, u.y)];
        if (own && own !== u.pref) u.hp -= CONFIG.ATTRITION * dt;
        else if (u.engaged < 0 && !got) u.hp = Math.min(def.hp, u.hp + CONFIG.REGEN * dt);
      }
      if (u.buff && u.buff.heal && !got) u.hp = Math.min(def.hp, u.hp + u.buff.heal * dt);
      if (def.fuel) { u.fuel -= dt; if (u.fuel <= 0) { u.alive = false; continue; } }   // 燃料切れ：基地へ帰る
      if (u.hp <= 0) { u.alive = false; this.stats.kills++; this.emit('death', u); }
    }
    for (const b of this.buildings.slice()) if (b.hp <= 0) this.removeBuilding(b);
  }
  moveAll(dt) {
    const base = CONFIG.UNIT_SPEED * this.S * dt;
    for (const u of this.units) {
      u.px = u.x; u.py = u.y;
      if (u.engaged >= 0 || u.hitB) continue;
      const def = UNITS[u.type], sp = base * def.spd * (u.buff ? u.buff.spd : 1);
      let tx, ty, stopAt = 0;
      if (u.chase >= 0) {
        const e = this.unitIndex.get(u.chase);
        if (!e || !e.alive || Math.hypot(e.x - u.x, e.y - u.y) > CONFIG.AGGRO_RANGE * this.S * (u.bit === 4 ? 4.8 : 1.6)) { u.chase = -1; u.thinkAt = 0; continue; }
        tx = e.x; ty = e.y; stopAt = def.range * 0.7;
      } else if (u.dest) {
        if (u.path && u.pi < u.path.length) [tx, ty] = u.path[u.pi];
        else [tx, ty] = u.dest;
      } else {
        if (u.bit === 4 && u.goalNode >= 0) { const n = this.nodes[u.goalNode]; const a = this.time * 0.8 + u.id; tx = n.x + Math.cos(a) * 3; ty = n.y + Math.sin(a) * 3; }   // 上空で旋回
        else continue;
      }
      const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
      if (d <= stopAt) continue;
      if (u.bit === 2) { this.sail(u, dx / d, dy / d, Math.min(sp, d - stopAt)); if (d - stopAt <= sp) { u.dest = null; } continue; }
      if (d - stopAt <= sp) {
        u.x = tx - (stopAt ? dx / d * stopAt : 0); u.y = ty - (stopAt ? dy / d * stopAt : 0);
        if (u.chase < 0) { if (u.path && u.pi < u.path.length) u.pi++; else { u.dest = null; u.path = null; } }
      } else { u.x += dx / d * sp; u.y += dy / d * sp; }
    }
  }
  /** 軍艦：海の上だけを進む。前が陸なら少しずつ向きを変えて岸に沿う */
  sail(u, ux, uy, sp) {
    for (const a of [0, 0.5, -0.5, 1, -1, 1.6, -1.6]) {
      const c = Math.cos(a), s = Math.sin(a), vx = ux * c - uy * s, vy = ux * s + uy * c;
      const nx = u.x + vx * sp, ny = u.y + vy * sp;
      if (this.isSea(nx, ny) && this.isSea(nx + vx * this.S, ny + vy * this.S)) { u.x = nx; u.y = ny; return; }
    }
    if (++u.stuck > 40) { u.dest = null; u.goalNode = -1; u.stuck = 0; }
  }

  // ---------------------------------------------------------- 占領
  updateNodes(dt) {
    const cnt = this.cnt;
    for (const n of this.nodes) {
      const touched = [];
      this.forUnitsNear(n.x, n.y, CONFIG.CAPTURE_RADIUS, (v) => { if (v.bit !== 1) return; if (!cnt[v.pref]) touched.push(v.pref); cnt[v.pref]++; });
      const def = cnt[n.owner];
      let A = 0, ac = 0;
      for (const p of touched) if (p !== n.owner && cnt[p] > ac) { ac = cnt[p]; A = p; }
      for (const p of touched) cnt[p] = 0;
      n.defenders = def; n.attackers = ac;
      // 攻撃側が守備側より多いとき、その差の人数ぶん占領が進む（数で押せば守備がいても落とせる）
      if (!A || ac <= def) { n.progress = Math.max(0, n.progress - CONFIG.CAPTURE_DECAY * dt * (def ? 4 : 1)); if (!n.progress) n.capBy = 0; continue; }
      if (n.capBy !== A) { n.capBy = A; n.progress = 0; }
      n.progress += dt * Math.min(ac - def, CONFIG.CAPTURE_MAX_RATE);
      if (n.progress >= this.needFor(n)) this.capture(n, A);
    }
  }
  capture(n, A) {
    const old = n.owner;
    n.owner = A; n.progress = 0; n.capBy = 0; n.capturedAt = this.time; n.byPlayer = false; n.wallet = -1;
    this.nodeCount[old]--; this.nodeCount[A]++;
    const cells = this.cellsOf(n.id);
    let moved = 0;
    const changed = [];
    for (const i of cells) {
      const o = this.owner[i];
      if (o === A) continue;
      this.moveCell(i, o, A);
      changed.push(i);
      moved++;
    }
    this.flipBuildings(changed, A);
    this.stats.captures++;
    this.recent.push({ node: n.id, until: this.time + CONFIG.RECENT_HATCH });
    this.emit('cells', cells);
    this.emit('capture', { node: n, from: old, by: A, cells: moved });
    if (this.nodeCount[old] === 0) this.eliminate(old);
    this.checkEnd();
  }
  updateRecent() {
    if (!this.recent.length || this.recent[0].until > this.time) return;
    const keep = [];
    for (const r of this.recent) {
      if (r.until > this.time) keep.push(r);
      else this.emit('cells', this.cellsOf(r.node));
    }
    this.recent = keep;
  }
  eliminate(p) {
    if (this.eliminated.has(p)) return;
    this.eliminated.add(p);
    this.units = this.units.filter((u) => u.pref !== p);
    this.emit('eliminated', p);
  }
  checkEnd() {
    if (this.over) return;
    const need = this.popTotal * CONFIG.WIN_RATIO;   // 全国の人口の半分を支配したら即優勝
    const me = this.me;
    if (!me) {
      // サーバー：どこかの県が過半数を取るか、シーズンが終わったら終了
      for (let p = 1; p <= 47; p++) if (this.pop[p] >= need) { this.over = { win: false, reason: 'majority', winner: p }; break; }
      if (!this.over && this.time >= CONFIG.SEASON_DAYS * 86400) this.over = { win: false, reason: 'season', winner: this.ranking()[0] };
    }
    else if (this.nodeCount[me] === 0) this.over = { win: false, reason: 'lost' };
    else if (this.pop[me] >= need) this.over = { win: true, reason: 'majority' };
    else for (let p = 1; p <= 47; p++) if (p !== this.me && this.pop[p] >= need) { this.over = { win: false, reason: 'rival', rival: p }; break; }
    // シーズン終了：その時点で領土が一番広い県の勝ち
    if (!this.over && this.time >= CONFIG.SEASON_DAYS * 86400) {
      const top = this.ranking()[0];
      this.over = { win: top === this.me, reason: 'season', rival: top };
    }
    if (this.over) { this.over.time = this.time; this.emit('over', this.over); }
  }

  // ---------------------------------------------------------- プレイヤーの命令
  playerBuild(type, c) { return this.build(type, this.me, c, 0); }
  humanBuild(w, type, c) { const h = this.humans.get(w); return h ? this.build(type, h.pref, c, w) : { ok: false, why: 'nohuman' }; }
  rallyOf(w) { if (w === 0) return this.rally; const h = this.humans.get(w); return h ? h.rally : -1; }
  setRally(nodeId, w = 0) {
    if (w === 0) this.rally = nodeId;
    else { const h = this.humans.get(w); if (!h) return; h.rally = nodeId; }
    for (const u of this.units) if (u.fromPlayer && u.hw === w) { u.goalNode = -1; u.thinkAt = this.time; }
  }
  ranking() {
    const arr = [];
    for (let p = 1; p <= 47; p++) if (this.present(p)) arr.push(p);
    arr.sort((a, b) => this.pop[b] - this.pop[a] || this.counts[b] - this.counts[a] || a - b);   // 順位は支配人口
    return arr;
  }
  rankOf(p) { return this.ranking().indexOf(p) + 1; }
  myBuildings(w = 0) { const P = this.prefOfWallet(w); return this.buildings.filter((b) => b.wallet === w).length + this.nodes.filter((n) => n.wallet === w && n.owner === P).length; }
  myUnits(w = 0) { let n = 0; for (const u of this.units) if (u.hw === w) n++; return n; }
}
function pl0(sim, P) { return sim.plans[P] && sim.plans[P].target >= 0; }
