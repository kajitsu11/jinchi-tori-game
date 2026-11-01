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

/** 8×8マスのブロック単位の移動グラフ（陸地を含むブロックだけ通れる。連絡マスは追加の辺） */
class NavGrid {
  constructor(map) {
    const B = 12, W = map.W, H = map.H;   // 12×12マスのブロック
    this.B = B; this.W = W;
    this.bw = Math.ceil(W / B); this.bh = Math.ceil(H / B);
    const n = this.bw * this.bh;
    this.rep = new Int32Array(n).fill(-1);       // ブロック内で中心に一番近い陸地マス
    const best = new Float32Array(n).fill(1e9);
    const ip = map.initPref;
    for (let i = 0; i < map.N; i++) {
      if (!ip[i]) continue;
      const x = i % W, y = (i / W) | 0;
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
  blockOfCell(i) { const x = i % this.W, y = (i / this.W) | 0; return ((y / this.B) | 0) * this.bw + ((x / this.B) | 0); }
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
      pts.push([(c % this.W) + 0.5, ((c / this.W) | 0) + 0.5]);
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

class Sim {
  constructor(map, me, seed) {
    this.map = map;
    this.me = me;
    this.rng = mulberry32(seed);
    const N = map.N, W = map.W;
    this.time = 0; this.acc = 0; this.incomeT = 0;
    this.listeners = {};
    this.owner = map.initPref.slice();
    this.counts = new Int32Array(49);
    this.counts.set(map.initCounts);
    this.landIdx = new Int32Array(map.landCells);
    for (let i = 0, k = 0; i < N; i++) if (map.initPref[i]) this.landIdx[k++] = i;
    this.offs = [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1];
    // ---- 拠点（県庁・町・砦）
    this.nodes = [];
    for (let p = 1; p <= 47; p++) {
      this.addNode({ cell: map.capitalCell[p], pref: p, type: 'capital', name: `${map.prefs[p].name}庁（${map.prefs[p].capName}）` });
    }
    for (const t of map.raw.towns) {
      const c = map.capitalCell[t.pref];
      if (Math.hypot(t.cell % W - c % W, ((t.cell / W) | 0) - ((c / W) | 0)) < 18) continue;
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
    this.parts = new Int32Array(49);
    for (let p = 1; p <= 47; p++) this.parts[p] = this.participantCount(p);
    this.res = { food: new Float64Array(48), wood: new Float64Array(48), gold: new Float64Array(48) };
    for (let w = 0; w <= 47; w++) {
      const k = w === 0 ? 1 : (w === me ? this.parts[w] - 1 : this.parts[w]);
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
      for (let k = 0; k < n; k++) this.spawnUnit(p, this.nodes[p - 1].x, this.nodes[p - 1].y, 20, false);
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
    this.over = null;
    this.recent = [];
    this.stats = { captures: 0, kills: 0, built: 0, destroyed: 0, trained: 0, paths: 0 };
    this.pathBudget = 0;
    this.income = { food: 0, wood: 0, gold: 0 };   // プレイヤーの直近の収入/秒
    this.shots = [];                                // 塔・砦の射撃（描画用）
    this.tickNo = 0;
  }
  participantCount(p) {
    return Math.max(CONFIG.MIN_PARTICIPANTS, Math.round(this.map.prefs[p].pop / 100 * CONFIG.PARTICIPANTS_PER_MILLION));
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, ...a) { const l = this.listeners[ev]; if (l) for (const f of l) f(...a); }
  dispose() { this.listeners = {}; }

  // ---------------------------------------------------------- 地形・拠点
  forNeighbors(i, fn) {
    const ip = this.map.initPref;
    for (const o of this.offs) { const j = i + o; if (ip[j]) fn(j); }
    const ls = this.map.linkMap.get(i);
    if (ls) for (const j of ls) fn(j);
  }
  cellAt(x, y) { return (y | 0) * this.map.W + (x | 0); }
  addNode(o) {
    const W = this.map.W;
    const n = { id: this.nodes.length, cell: o.cell, x: (o.cell % W) + 0.5, y: ((o.cell / W) | 0) + 0.5, pref: o.pref,
      owner: o.owner || o.pref, type: o.type, name: o.name, progress: 0, capBy: 0, capturedAt: -999, attackers: 0, defenders: 0,
      byPlayer: !!o.byPlayer };
    this.nodes.push(n);
    return n;
  }
  assignTerritory() {
    const ip = this.map.initPref, nodeOf = this.nodeOf, dist = this.nodeDist, W = this.map.W;
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
        const d = Math.hypot(n.x - (i % W), n.y - ((i / W) | 0));
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
    const nodeOf = this.nodeOf, W = this.map.W, ip = this.map.initPref;
    for (const i of this.landIdx) {
      const a = nodeOf[i];
      for (const j of [i + 1, i + W, i + W + 1, i + W - 1]) {
        if (!ip[j]) continue;
        const b = nodeOf[j];
        if (a !== b) { adj[a].add(b); adj[b].add(a); }
      }
      const ls = this.map.linkMap.get(i);
      if (ls) for (const j of ls) { const b = nodeOf[j]; if (a !== b) { adj[a].add(b); adj[b].add(a); } }
    }
    this.nodeAdj = adj.map((s) => [...s]);
  }
  needFor(n) { return CONFIG.CAPTURE_NEED[n.type]; }
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
  walletOf(P, byPlayer) { return byPlayer && P === this.me ? 0 : P; }
  canAfford(w, cost) { for (const r of RES_KEYS) if ((cost[r] || 0) > this.res[r][w]) return false; return true; }
  pay(w, cost) { for (const r of RES_KEYS) this.res[r][w] -= cost[r] || 0; }
  forestNear(c, r) {
    const W = this.map.W, x0 = c % W, y0 = (c / W) | 0, t = this.map.terrain;
    let n = 0;
    for (let dy = -r; dy <= r; dy += 2) for (let dx = -r; dx <= r; dx += 2) {
      const i = (y0 + dy) * W + x0 + dx;
      if (i >= 0 && i < this.map.N && (t[i] & 7) === 2) n++;
    }
    return n;
  }
  /** 毎秒：基本収入（参加者数ぶん）＋拠点＋建物 */
  produce(sec) {
    const add = (w, r, v) => { this.res[r][w] += v * sec; };
    const me = this.me;
    const pinc = { food: 0, wood: 0, gold: 0 };
    for (let p = 1; p <= 47; p++) {
      if (!this.nodeCount[p]) continue;
      const k = p === me ? this.parts[p] - 1 : this.parts[p];
      for (const r of RES_KEYS) add(p, r, CONFIG.BASE_INCOME[r] * k);
    }
    if (this.nodeCount[me]) for (const r of RES_KEYS) { add(0, r, CONFIG.BASE_INCOME[r]); pinc[r] += CONFIG.BASE_INCOME[r]; }
    for (const n of this.nodes) {
      const mk = n.type === 'capital' ? CONFIG.CAPITAL_MAKE : n.type === 'town' ? BUILDINGS.town.make : null;
      if (!mk) continue;
      const w = n.byPlayer && n.owner === me ? 0 : n.owner;
      for (const r in mk) { add(w, r, mk[r]); if (!w) pinc[r] += mk[r]; }
    }
    for (const b of this.buildings) {
      const def = BUILDINGS[b.type];
      if (def.make) for (const r in def.make) { const v = def.make[r] * b.mul; add(b.wallet, r, v); if (!b.wallet) pinc[r] += v; }
      if (def.forest) { const v = Math.min(CONFIG.LUMBER_MAX, b.forest * CONFIG.LUMBER_PER_FOREST); add(b.wallet, 'wood', v); if (!b.wallet) pinc.wood += v; }
    }
    this.income = pinc;
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
    const def = BUILDINGS[type], map = this.map, W = map.W;
    if (c < 0 || c >= map.N || !map.initPref[c]) return 'sea';
    if (this.owner[c] !== P) return 'notown';
    const x = c % W + 0.5, y = ((c / W) | 0) + 0.5, t = map.terrain[c] & 7;
    let blocked = false;
    this.buildingsNear(x, y, CONFIG.BUILD_GAP, () => { blocked = true; });
    if (blocked) return 'crowded';
    for (const n of this.nodes) {
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < (def.node ? CONFIG.NODE_MIN_DIST : CONFIG.BUILD_GAP + 1)) return def.node ? 'nearnode' : 'crowded';
    }
    if (type === 'farm' && t === 3) return 'terrain';
    if (type === 'lumber' && this.forestNear(c, 6) < CONFIG.LUMBER_MIN_FOREST) return 'noforest';
    if (!this.canAfford(w, def.cost)) return 'cost';
    return null;
  }
  build(type, P, c, byPlayer) {
    const w = this.walletOf(P, byPlayer);
    const why = this.canBuild(type, P, c, w);
    if (why) return { ok: false, why };
    const def = BUILDINGS[type], W = this.map.W;
    this.pay(w, def.cost);
    this.stats.built++;
    if (def.node) {
      const n = this.buildNode(P, c, type, byPlayer);
      this.emit('built', { node: n, type, by: P, byPlayer });
      return { ok: true, node: n };
    }
    const b = { id: ++this.bseq, type, cell: c, x: c % W + 0.5, y: ((c / W) | 0) + 0.5, owner: P, wallet: w, byPlayer: !!byPlayer,
      hp: def.hp, maxHp: def.hp, t: 0, rot: (this.rng() * 4 | 0) * Math.PI / 2, forest: def.forest ? this.forestNear(c, 6) : 0,
      mul: type === 'farm' && (this.map.terrain[c] & 7) === 2 ? 0.5 : 1 };   // 森を切り開いた農場は収穫が半分
    this.buildings.push(b);
    const k = this.bkey(b.x, b.y);
    if (!this.bgrid.has(k)) this.bgrid.set(k, []);
    this.bgrid.get(k).push(b);
    this.emit('built', { building: b, type, by: P, byPlayer });
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
  buildNode(P, c, type, byPlayer) {
    const k = this.nodes.filter((n) => n.type === type && n.pref === P).length + 1;
    const n = this.addNode({ cell: c, pref: P, owner: P, type, name: `${this.map.prefs[P].short}の${BUILDINGS[type].name}${k}`, byPlayer });
    this.nodeCount[P]++;
    const nodeOf = this.nodeOf, dist = this.nodeDist;
    const changed = [], claimed = [];
    const q = [c], d = new Map([[c, 0]]);
    const take = (i, di) => {
      nodeOf[i] = n.id; dist[i] = di; claimed.push(i);
      if (this.owner[i] !== P) { this.counts[this.owner[i]]--; this.counts[P]++; this.owner[i] = P; changed.push(i); }
    };
    take(c, 0);
    for (let qh = 0; qh < q.length; qh++) {
      const i = q[qh], di = d.get(i) + 1;
      if (di > CONFIG.NODE_RADIUS) continue;
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
  spawnUnit(P, x, y, r, fromPlayer) {
    const W = this.map.W;
    let px = x, py = y;
    for (let k = 0; k < 12; k++) {
      const tx = x + (this.rng() * 2 - 1) * r, ty = y + (this.rng() * 2 - 1) * r;
      const i = this.cellAt(tx, ty);
      if (i >= 0 && i < this.map.N && this.owner[i] === P) { px = tx; py = ty; break; }
    }
    const u = { id: this.useq++, pref: P, fromPlayer, role: this.rng() < CONFIG.AI_DEFENDER_RATIO ? 'def' : 'atk',
      x: px, y: py, px, py, hp: CONFIG.UNIT_HP, alive: true, path: null, pi: 0, dest: null, goalNode: -1, chase: -1, engaged: -1, hitB: null,
      thinkAt: this.time + this.rng(), offX: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2, offY: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2 };
    if (fromPlayer) u.role = 'atk';
    this.units.push(u);
    return u;
  }
  unitCap(P) { return this.parts[P] * CONFIG.UNIT_CAP_PER_PARTICIPANT + this.nodeCount[P] * CONFIG.UNIT_CAP_PER_NODE; }
  unitCount(P) { let n = 0; for (const u of this.units) if (u.pref === P) n++; return n; }
  trainAll(dt) {
    const cnt = new Int32Array(49);
    for (const u of this.units) cnt[u.pref]++;
    for (const b of this.buildings) {
      if (b.type !== 'barracks') continue;
      const def = BUILDINGS.barracks;
      b.t += dt;
      if (b.t < def.train) continue;
      if (cnt[b.owner] >= this.unitCap(b.owner) || this.res.food[b.wallet] < def.trainFood) { b.t = def.train; continue; }
      b.t = 0;
      this.res.food[b.wallet] -= def.trainFood;
      this.spawnUnit(b.owner, b.x, b.y, 2.5, b.wallet === 0);
      cnt[b.owner]++;
      this.stats.trained++;
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
  nearestEnemy(x, y, P, r) {
    let best = null, bd = 1e9;
    this.forUnitsNear(x, y, r, (v, d2) => { if (v.pref !== P && d2 < bd) { bd = d2; best = v; } });
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
      const cap = this.nodes[P - 1];
      const cx = k ? sx / k : cap.x, cy = k ? sy / k : cap.y;
      let best = -1, bs = -1e9;
      const seen = new Set();
      for (const n of this.nodes) {
        if (n.owner !== P) continue;
        for (const a of this.nodeAdj[n.id]) {
          const e = this.nodes[a];
          if (e.owner === P || seen.has(a)) continue;
          seen.add(a);
          const s = this.rng() * 1.5 - e.defenders * 0.4 - Math.hypot(e.x - cx, e.y - cy) / 120
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
      const k = Math.max(1, p === this.me ? this.parts[p] - 1 : this.parts[p]);
      this.aiBuildAt[p] = this.time + CONFIG.AI_BUILD_INTERVAL * 10 / k * (0.6 + this.rng() * 0.8);
      this.aiBuild(p, k);
    }
  }
  aiBuild(P, k) {
    const mine = { farm: 0, lumber: 0, market: 0, barracks: 0, tower: 0 };
    let total = 0;
    for (const b of this.buildings) if (b.owner === P && b.wallet === P) { mine[b.type]++; total++; }
    if (total >= k * CONFIG.MAX_BUILDINGS_PER_PARTICIPANT) return;
    const nodes = this.nodeCount[P];
    const want = [];
    if (mine.farm < 2 + nodes * 1.5) want.push('farm');
    if (mine.lumber < 1 + nodes) want.push('lumber');
    if (mine.barracks < 1 + nodes / 3) want.push('barracks');
    if (mine.market < nodes / 2) want.push('market');
    if (mine.tower < nodes / 2) want.push('tower');
    // 町・砦（国境を広げる）はときどき。県の参加者数に応じた上限まで
    if (nodes < 6 + k * 0.5 && this.rng() < 0.1) want.push(this.rng() < 0.6 ? 'town' : 'fort');
    if (!want.length) want.push(['farm', 'barracks', 'tower', 'market'][(this.rng() * 4) | 0]);
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
    const W = this.map.W;
    for (let tries = 0; tries < 14; tries++) {
      const n = list[(this.rng() * list.length) | 0];
      const r = BUILDINGS[type].node ? CONFIG.NODE_MIN_DIST + this.rng() * 15 : 3 + this.rng() * 20;
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
      if (!u.alive || this.time < u.thinkAt) continue;
      u.thinkAt = this.time + CONFIG.THINK_INTERVAL * (0.8 + this.rng() * 0.6);
      this.think(u);
    }
  }
  think(u) {
    const e = this.nearestEnemy(u.x, u.y, u.pref, CONFIG.AGGRO_RANGE);
    if (e) { u.chase = e.id; return; }
    u.chase = -1;
    const pl = this.plans[u.pref];
    let node = -1;
    if (u.fromPlayer && this.rally >= 0 && this.nodes[this.rally].owner !== u.pref) node = this.rally;
    else if (u.role === 'def') node = pl.defend >= 0 ? pl.defend : this.homeNode(u);
    else node = pl.target >= 0 ? pl.target : (pl.defend >= 0 ? pl.defend : -1);
    if (node < 0) return;
    if (u.goalNode === node && (u.path || u.dest)) return;
    const n = this.nodes[node];
    if (!this.setDest(u, n.x + u.offX, n.y + u.offY)) { u.thinkAt = this.time + 0.3; return; }
    u.goalNode = node;
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
  combat(dt) {
    this.unitIndex = new Map();
    const U = this.units;
    if (!this.dmg || this.dmg.length < U.length) this.dmg = new Float32Array(U.length * 2);
    const dmg = this.dmg;
    for (let k = 0; k < U.length; k++) { U[k].k = k; dmg[k] = 0; this.unitIndex.set(U[k].id, U[k]); }
    const hit = (v, a) => { dmg[v.k] += a; };
    for (const u of this.units) {
      if (!u.alive) continue;
      const e = this.nearestEnemy(u.x, u.y, u.pref, CONFIG.ATTACK_RANGE);
      u.engaged = e ? e.id : -1;
      u.hitB = null;
      const mult = this.owner[this.cellAt(u.x, u.y)] === u.pref ? CONFIG.HOME_BONUS : 1;
      if (e) { hit(e, CONFIG.UNIT_DPS * dt * mult); continue; }
      // 敵兵がいなければ、近くの敵の建物を壊す
      let tb = null, bd = 1e9;
      this.buildingsNear(u.x, u.y, CONFIG.ATTACK_RANGE + 1.2, (b, d) => { if (b.owner !== u.pref && d < bd) { bd = d; tb = b; } });
      if (tb) { tb.hp -= CONFIG.UNIT_DPS * CONFIG.BUILDING_DPS_MULT * dt; tb.hitAt = this.time; u.hitB = tb; }
    }
    // 塔・砦・県庁が近くの敵兵を撃つ（重くならないよう、それぞれ0.5秒に1回まとめて撃つ）
    this.tickNo = (this.tickNo || 0) + 1;
    if (this.tickNo % 5 === 0) this.shots = [];
    const slot = this.tickNo % 5, sdt = dt * 5;
    const shoot = (id, x, y, P, range, dps) => {
      if (id % 5 !== slot) return;
      const e = this.nearestEnemy(x, y, P, range);
      if (e) { hit(e, dps * sdt); if (this.shots.length < 300) this.shots.push([x, y, e.x, e.y]); }
    };
    for (const b of this.buildings) if (b.type === 'tower') shoot(b.id, b.x, b.y, b.owner, BUILDINGS.tower.range, BUILDINGS.tower.dps);
    for (const n of this.nodes) {
      if (n.type === 'fort') shoot(n.id, n.x, n.y, n.owner, BUILDINGS.fort.range, BUILDINGS.fort.dps);
      else if (n.type === 'capital') shoot(n.id, n.x, n.y, n.owner, CONFIG.CAPITAL_RANGE, CONFIG.CAPITAL_DPS);
    }
    for (const u of this.units) {
      if (!u.alive) continue;
      const got = dmg[u.k];
      u.hp -= got;
      const own = this.owner[this.cellAt(u.x, u.y)];
      if (own && own !== u.pref) u.hp -= CONFIG.ATTRITION * dt;
      else if (u.engaged < 0 && !got) u.hp = Math.min(CONFIG.UNIT_HP, u.hp + CONFIG.REGEN * dt);
      if (u.hp <= 0) { u.alive = false; this.stats.kills++; this.emit('death', u); }
    }
    for (const b of this.buildings.slice()) if (b.hp <= 0) this.removeBuilding(b);
  }
  moveAll(dt) {
    const sp = CONFIG.UNIT_SPEED * dt;
    for (const u of this.units) {
      u.px = u.x; u.py = u.y;
      if (u.engaged >= 0 || u.hitB) continue;
      let tx, ty, stopAt = 0;
      if (u.chase >= 0) {
        const e = this.unitIndex.get(u.chase);
        if (!e || !e.alive || Math.hypot(e.x - u.x, e.y - u.y) > CONFIG.AGGRO_RANGE * 1.6) { u.chase = -1; u.thinkAt = 0; continue; }
        tx = e.x; ty = e.y; stopAt = CONFIG.ATTACK_RANGE * 0.7;
      } else if (u.dest) {
        if (u.path && u.pi < u.path.length) [tx, ty] = u.path[u.pi];
        else [tx, ty] = u.dest;
      } else continue;
      const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
      if (d <= stopAt) continue;
      if (d - stopAt <= sp) {
        u.x = tx - (stopAt ? dx / d * stopAt : 0); u.y = ty - (stopAt ? dy / d * stopAt : 0);
        if (u.chase < 0) { if (u.path && u.pi < u.path.length) u.pi++; else { u.dest = null; u.path = null; } }
      } else { u.x += dx / d * sp; u.y += dy / d * sp; }
    }
  }

  // ---------------------------------------------------------- 占領
  updateNodes(dt) {
    const cnt = this.cnt;
    for (const n of this.nodes) {
      const touched = [];
      this.forUnitsNear(n.x, n.y, CONFIG.CAPTURE_RADIUS, (v) => { if (!cnt[v.pref]) touched.push(v.pref); cnt[v.pref]++; });
      const def = cnt[n.owner];
      let A = 0, ac = 0;
      for (const p of touched) if (p !== n.owner && cnt[p] > ac) { ac = cnt[p]; A = p; }
      for (const p of touched) cnt[p] = 0;
      n.defenders = def; n.attackers = ac;
      if (!A || def > 0) { n.progress = Math.max(0, n.progress - CONFIG.CAPTURE_DECAY * dt); if (!n.progress) n.capBy = 0; continue; }
      if (n.capBy !== A) { n.capBy = A; n.progress = 0; }
      n.progress += dt * Math.min(ac, CONFIG.CAPTURE_MAX_RATE);
      if (n.progress >= this.needFor(n)) this.capture(n, A);
    }
  }
  capture(n, A) {
    const old = n.owner;
    n.owner = A; n.progress = 0; n.capBy = 0; n.capturedAt = this.time; n.byPlayer = false;
    this.nodeCount[old]--; this.nodeCount[A]++;
    const cells = this.cellsOf(n.id);
    let moved = 0;
    const changed = [];
    for (const i of cells) {
      const o = this.owner[i];
      if (o === A) continue;
      this.counts[o]--; this.counts[A]++;
      this.owner[i] = A;
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
    const need = this.map.landCells * CONFIG.WIN_RATIO;
    if (this.nodeCount[this.me] === 0) this.over = { win: false, reason: 'lost' };
    else if (this.counts[this.me] >= need) this.over = { win: true, reason: 'majority' };
    else for (let p = 1; p <= 47; p++) if (p !== this.me && this.counts[p] >= need) { this.over = { win: false, reason: 'rival', rival: p }; break; }
    // シーズン終了：その時点で領土が一番広い県の勝ち
    if (!this.over && this.time >= CONFIG.SEASON_DAYS * 86400) {
      const top = this.ranking()[0];
      this.over = { win: top === this.me, reason: 'season', rival: top };
    }
    if (this.over) { this.over.time = this.time; this.emit('over', this.over); }
  }

  // ---------------------------------------------------------- プレイヤーの命令
  playerBuild(type, c) { return this.build(type, this.me, c, true); }
  setRally(nodeId) {
    this.rally = nodeId;
    for (const u of this.units) if (u.fromPlayer) { u.goalNode = -1; u.thinkAt = this.time; }
  }
  ranking() {
    const arr = [];
    for (let p = 1; p <= 47; p++) arr.push(p);
    arr.sort((a, b) => this.counts[b] - this.counts[a] || a - b);
    return arr;
  }
  rankOf(p) { return this.ranking().indexOf(p) + 1; }
  myBuildings() { return this.buildings.filter((b) => b.wallet === 0).length + this.nodes.filter((n) => n.byPlayer && n.owner === this.me).length; }
  myUnits() { let n = 0; for (const u of this.units) if (u.fromPlayer) n++; return n; }
}
function pl0(sim, P) { return sim.plans[P] && sim.plans[P].target >= 0; }
