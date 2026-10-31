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
    const B = 8, W = map.W, H = map.H;
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
    // ---- 拠点
    this.nodes = [];
    for (let p = 1; p <= 47; p++) {
      this.addNode({ cell: map.capitalCell[p], pref: p, type: 'capital', name: `${map.prefs[p].name}庁（${map.prefs[p].capName}）` });
    }
    for (const t of map.raw.towns) {
      const c = map.capitalCell[t.pref];
      if (Math.hypot(t.cell % W - c % W, ((t.cell / W) | 0) - ((c / W) | 0)) < 12) continue;
      this.addNode({ cell: t.cell, pref: t.pref, type: 'town', name: t.name });
    }
    this.nodeOf = new Int16Array(N).fill(-1);
    this.nodeDist = new Uint16Array(N).fill(65535);
    this.assignTerritory();
    this.nodeCount = new Int32Array(49);
    for (const n of this.nodes) this.nodeCount[n.owner]++;
    this.rebuildNodeCells();
    this.computeNodeAdj();
    // ---- 部隊（参加者1人＝1部隊）
    this.nav = map.nav || (map.nav = new NavGrid(map));
    this.units = [];
    for (let p = 1; p <= 47; p++) {
      const n = this.participantCount(p);
      for (let k = 0; k < n; k++) {
        const isPlayer = p === me && k === 0;
        const c = this.randomCellNear(map.capitalCell[p], 14, p);
        const u = {
          id: this.units.length, pref: p, player: isPlayer,
          role: isPlayer ? 'player' : (this.rng() < CONFIG.AI_DEFENDER_RATIO ? 'def' : 'atk'),
          x: (c % W) + this.rng(), y: ((c / W) | 0) + this.rng(), px: 0, py: 0,
          hp: CONFIG.UNIT_HP, alive: true, respawnAt: 0,
          path: null, pi: 0, dest: null, goalNode: -1, chase: -1, engaged: -1,
          thinkAt: this.rng() * 2, offX: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2, offY: (this.rng() - 0.5) * CONFIG.CAPTURE_RADIUS * 1.2,
          lastHitBy: 0, kills: 0,
        };
        u.px = u.x; u.py = u.y;
        this.units.push(u);
      }
    }
    this.player = this.units.find((u) => u.player);
    this.auto = false;                 // プレイヤーの部隊をAIにまかせるか
    this.gold = new Float64Array(49);
    for (let p = 1; p <= 47; p++) this.gold[p] = CONFIG.START_GOLD;
    this.plans = [];
    for (let p = 0; p <= 47; p++) {
      this.plans.push({ target: -1, since: 0, defend: -1, next: this.rng() * CONFIG.AI_PLAN_INTERVAL, lastFort: -this.rng() * CONFIG.AI_FORT_INTERVAL });
    }
    // ---- 空間ハッシュ（16マス四方のバケツ）
    this.hs = 16;
    this.hw = Math.ceil(W / this.hs); this.hh = Math.ceil(map.H / this.hs);
    this.head = new Int32Array(this.hw * this.hh);
    this.next = new Int32Array(this.units.length);
    this.dmg = new Float32Array(this.units.length);
    this.cnt = new Int32Array(49);
    this.eliminated = new Set();
    this.over = null;
    this.recent = [];                  // 最近占領された拠点（斜線表示用）
    this.stats = { captures: 0, kills: 0, forts: 0, paths: 0 };
    this.pathBudget = 0;
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
      owner: o.owner || o.pref, type: o.type, name: o.name, progress: 0, capBy: 0, capturedAt: -999, attackers: 0, defenders: 0 };
    this.nodes.push(n);
    return n;
  }
  randomCellNear(c, r, P) {
    const W = this.map.W, cx = c % W, cy = (c / W) | 0;
    for (let k = 0; k < 40; k++) {
      const x = Math.round(cx + (this.rng() * 2 - 1) * r), y = Math.round(cy + (this.rng() * 2 - 1) * r);
      const i = y * W + x;
      if (i >= 0 && i < this.map.N && this.owner[i] === P) return i;
    }
    return c;
  }
  /** 各マスを「同じ県の中で一番近い拠点」に割り当てる（陸地をたどる距離） */
  assignTerritory() {
    const ip = this.map.initPref, nodeOf = this.nodeOf, dist = this.nodeDist, W = this.map.W;
    const q = new Int32Array(this.map.landCells + this.nodes.length);
    let qh = 0, qt = 0;
    for (const n of this.nodes) { nodeOf[n.cell] = n.id; dist[n.cell] = 0; q[qt++] = n.cell; }
    while (qh < qt) {
      const i = q[qh++], nid = nodeOf[i], P = this.nodes[nid].pref, d = dist[i] + 1;
      this.forNeighbors(i, (j) => {
        if (nodeOf[j] === -1 && ip[j] === P) { nodeOf[j] = nid; dist[j] = d; q[qt++] = j; }
      });
    }
    // 他県を経由しないと届かない小島など：同じ県の一番近い拠点へ
    for (const i of this.landIdx) {
      if (nodeOf[i] !== -1) continue;
      let best = -1, bd = 1e9;
      for (const n of this.nodes) {
        if (n.pref !== ip[i]) continue;
        const d = Math.hypot(n.x - (i % W), n.y - ((i / W) | 0));
        if (d < bd) { bd = d; best = n.id; }
      }
      nodeOf[i] = best; dist[i] = Math.min(65000, Math.round(bd));
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
  /** 今その拠点に属しているマス（砦に取られたマスは除く） */
  cellsOf(id) {
    const list = this.nodeCells[id], nodeOf = this.nodeOf;
    let stale = 0;
    for (let k = 0; k < list.length; k++) if (nodeOf[list[k]] !== id) stale++;
    if (!stale) return list;
    const out = new Int32Array(list.length - stale);
    for (let k = 0, j = 0; k < list.length; k++) if (nodeOf[list[k]] === id) out[j++] = list[k];
    this.nodeCells[id] = out;   // 詰め直しておく
    return out;
  }
  isRecent(i) { const n = this.nodes[this.nodeOf[i]]; return n && this.time - n.capturedAt < CONFIG.RECENT_HATCH; }

  // ---------------------------------------------------------- 進行
  update(dt) {
    if (this.over) return;
    this.acc += dt;
    let steps = 0;
    while (this.acc >= CONFIG.TICK && steps < 5 && !this.over) { this.step(CONFIG.TICK); this.acc -= CONFIG.TICK; steps++; }
    if (steps >= 5) this.acc = 0;   // 処理が追いつかないときは時間を捨てる
  }
  step(dt) {
    this.time += dt;
    this.pathBudget = CONFIG.PATH_BUDGET;
    this.incomeT += dt;
    if (this.incomeT >= 1) {
      this.incomeT -= 1;
      for (let p = 1; p <= 47; p++) this.gold[p] += this.income(p);
    }
    this.buildHash();
    this.planAll();
    this.thinkAll();
    this.combat(dt);
    this.moveAll(dt);
    this.updateNodes(dt);
    this.updateRecent();
  }
  income(p) {
    const c = this.counts[p];
    if (!c) return 0;
    return CONFIG.INCOME_LAND * Math.sqrt(c / 100) + CONFIG.INCOME_NODE * this.nodeCount[p];
  }
  buildHash() {
    this.head.fill(-1);
    const hs = this.hs, hw = this.hw;
    for (const u of this.units) {
      if (!u.alive) continue;
      const b = ((u.y / hs) | 0) * hw + ((u.x / hs) | 0);
      this.next[u.id] = this.head[b];
      this.head[b] = u.id;
    }
  }
  forUnitsNear(x, y, r, fn) {
    const hs = this.hs, r2 = r * r;
    const bx0 = Math.max(0, ((x - r) / hs) | 0), bx1 = Math.min(this.hw - 1, ((x + r) / hs) | 0);
    const by0 = Math.max(0, ((y - r) / hs) | 0), by1 = Math.min(this.hh - 1, ((y + r) / hs) | 0);
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      for (let k = this.head[by * this.hw + bx]; k >= 0; k = this.next[k]) {
        const v = this.units[k], dx = v.x - x, dy = v.y - y, d2 = dx * dx + dy * dy;
        if (d2 <= r2) fn(v, d2);
      }
    }
  }
  nearestEnemy(u, r) {
    let best = null, bd = 1e9;
    this.forUnitsNear(u.x, u.y, r, (v, d2) => { if (v.pref !== u.pref && d2 < bd) { bd = d2; best = v; } });
    return best;
  }

  // ---------------------------------------------------------- AI（県ごとの作戦）
  planAll() {
    for (let p = 1; p <= 47; p++) {
      const pl = this.plans[p];
      if (this.time < pl.next || this.nodeCount[p] === 0) continue;
      pl.next = this.time + CONFIG.AI_PLAN_INTERVAL;
      this.plan(p, pl);
    }
  }
  plan(P, pl) {
    // 守る：敵に囲まれている自県の拠点
    let defend = -1, ds = 0;
    for (const n of this.nodes) {
      if (n.owner !== P || !n.attackers) continue;
      const s = n.progress / this.needFor(n) + n.attackers * 0.05 + (n.type === 'capital' ? 0.5 : 0);
      if (s > ds) { ds = s; defend = n.id; }
    }
    pl.defend = defend;
    // 攻める：自県の拠点に隣接する敵の拠点
    const cur = this.nodes[pl.target];
    if (!cur || cur.owner === P || this.time - pl.since > CONFIG.AI_TARGET_TIMEOUT) {
      // 部隊の重心
      let sx = 0, sy = 0, k = 0;
      for (const u of this.units) if (u.pref === P && u.alive) { sx += u.x; sy += u.y; k++; }
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
    // 砦：資金があれば、攻め先の手前に建てて国境を押し出す
    if (this.gold[P] - (P === this.me ? CONFIG.FORT_COST : 0) >= CONFIG.FORT_COST
      && this.time - pl.lastFort >= CONFIG.AI_FORT_INTERVAL && pl.target >= 0 && this.rng() < 0.6) {
      const e = this.nodes[pl.target];
      let own = null, bd = 1e9;
      for (const a of this.nodeAdj[e.id]) { const n = this.nodes[a]; if (n.owner === P) { const d = Math.hypot(n.x - e.x, n.y - e.y); if (d < bd) { bd = d; own = n; } } }
      if (own) {
        for (const f of [0.55, 0.45, 0.65, 0.35]) {
          const c = this.cellAt(own.x + (e.x - own.x) * f, own.y + (e.y - own.y) * f);
          if (!this.canBuildFort(P, c)) { this.buildFort(P, c, false); pl.lastFort = this.time; break; }
        }
      }
    }
  }
  thinkAll() {
    for (const u of this.units) {
      if (!u.alive) {
        if (this.time >= u.respawnAt) this.respawn(u);
        continue;
      }
      if (this.time < u.thinkAt) continue;
      if (u.player && !this.auto) { u.thinkAt = this.time + 1; continue; }
      u.thinkAt = this.time + 0.8 + this.rng() * 0.6;
      this.think(u);
    }
  }
  think(u) {
    // 近くに敵の部隊がいれば向かっていく
    const e = this.nearestEnemy(u, CONFIG.AGGRO_RANGE);
    if (e) { u.chase = e.id; return; }
    u.chase = -1;
    const pl = this.plans[u.pref];
    let node = -1;
    if (u.role === 'def') node = pl.defend >= 0 ? pl.defend : this.homeNode(u);
    else node = pl.target >= 0 ? pl.target : (pl.defend >= 0 ? pl.defend : -1);
    if (node < 0) return;
    if (u.goalNode === node && (u.path || u.dest)) return;
    const n = this.nodes[node];
    if (!this.setDest(u, n.x + u.offX, n.y + u.offY)) { u.thinkAt = this.time + 0.3; return; }
    u.goalNode = node;
  }
  /** 守備担当の持ち場：敵に接している自県の拠点のうち、自分に近いもの */
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
  /** 目的地を設定（経路探索）。今回の刻みの探索予算を使い切っていたら false */
  setDest(u, x, y) {
    if (this.pathBudget <= 0 && !u.player) return false;
    this.pathBudget--;
    this.stats.paths++;
    const path = this.nav.find(u.x, u.y, x, y);
    u.path = path || [];
    u.pi = 0;
    u.dest = [x, y];
    return true;
  }

  // ---------------------------------------------------------- 戦闘・移動
  combat(dt) {
    const dmg = this.dmg;
    dmg.fill(0);
    for (const u of this.units) {
      if (!u.alive) continue;
      const e = this.nearestEnemy(u, CONFIG.ATTACK_RANGE);
      u.engaged = e ? e.id : -1;
      if (!e) continue;
      const mult = this.owner[this.cellAt(u.x, u.y)] === u.pref ? CONFIG.HOME_BONUS : 1;
      dmg[e.id] += CONFIG.UNIT_DPS * dt * mult;
      e.lastHitBy = u.pref;
    }
    for (const u of this.units) {
      if (!u.alive) continue;
      u.hp -= dmg[u.id];
      const own = this.owner[this.cellAt(u.x, u.y)];
      if (own && own !== u.pref) u.hp -= CONFIG.ATTRITION * dt;
      else if (u.engaged < 0 && !dmg[u.id]) u.hp = Math.min(CONFIG.UNIT_HP, u.hp + CONFIG.REGEN * dt);
      if (u.hp <= 0) this.kill(u);
    }
  }
  kill(u) {
    u.alive = false; u.hp = 0;
    u.respawnAt = this.eliminated.has(u.pref) ? Infinity : this.time + CONFIG.RESPAWN;
    u.path = null; u.dest = null; u.goalNode = -1; u.chase = -1; u.engaged = -1;
    this.stats.kills++;
    for (const v of this.units) if (v.alive && v.pref === u.lastHitBy && Math.hypot(v.x - u.x, v.y - u.y) < CONFIG.ATTACK_RANGE + 1) { v.kills++; break; }
    this.emit('death', u);
  }
  respawn(u) {
    if (this.eliminated.has(u.pref)) { u.respawnAt = Infinity; return; }
    // 倒れた場所に一番近い自県の拠点で復活
    let best = null, bd = 1e9;
    for (const n of this.nodes) {
      if (n.owner !== u.pref) continue;
      const d = Math.hypot(n.x - u.x, n.y - u.y);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) { u.respawnAt = Infinity; return; }
    u.x = u.px = best.x + (this.rng() - 0.5) * 3;
    u.y = u.py = best.y + (this.rng() - 0.5) * 3;
    u.hp = CONFIG.UNIT_HP; u.alive = true; u.thinkAt = this.time + this.rng();
    this.emit('respawn', u);
  }
  moveAll(dt) {
    const sp = CONFIG.UNIT_SPEED * dt;
    for (const u of this.units) {
      u.px = u.x; u.py = u.y;
      if (!u.alive) continue;
      const commanded = u.player && !this.auto && u.dest;
      if (u.engaged >= 0 && !commanded) continue;          // 戦闘中は止まる（プレイヤーの移動命令中は退却できる）
      let tx, ty, stopAt = 0;
      if (u.chase >= 0 && !commanded) {
        const e = this.units[u.chase];
        if (!e.alive || Math.hypot(e.x - u.x, e.y - u.y) > CONFIG.AGGRO_RANGE * 1.6) { u.chase = -1; u.thinkAt = 0; continue; }
        tx = e.x; ty = e.y; stopAt = CONFIG.ATTACK_RANGE * 0.7;
      } else if (u.dest) {
        if (u.path && u.pi < u.path.length) { [tx, ty] = u.path[u.pi]; }
        else { [tx, ty] = u.dest; }
      } else continue;
      const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
      if (d <= stopAt) continue;
      if (d - stopAt <= sp) {
        u.x = tx - (stopAt ? dx / d * stopAt : 0); u.y = ty - (stopAt ? dy / d * stopAt : 0);
        if (u.chase < 0 || commanded) {
          if (u.path && u.pi < u.path.length) u.pi++;
          else { u.dest = null; u.path = null; if (u.player) this.emit('arrived', u); }
        }
      } else {
        u.x += dx / d * sp; u.y += dy / d * sp;
      }
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
    n.owner = A; n.progress = 0; n.capBy = 0; n.capturedAt = this.time;
    this.nodeCount[old]--; this.nodeCount[A]++;
    const cells = this.cellsOf(n.id);
    let moved = 0;
    for (const i of cells) {
      const o = this.owner[i];
      if (o === A) continue;
      this.counts[o]--; this.counts[A]++;
      this.owner[i] = A;
      moved++;
    }
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
      else this.emit('cells', this.cellsOf(r.node));    // 斜線を消す
    }
    this.recent = keep;
  }
  eliminate(p) {
    if (this.eliminated.has(p)) return;
    this.eliminated.add(p);
    for (const u of this.units) if (u.pref === p) { u.alive = false; u.respawnAt = Infinity; }
    this.emit('eliminated', p);
  }
  checkEnd() {
    if (this.over) return;
    const need = this.map.landCells * CONFIG.WIN_RATIO;
    if (this.nodeCount[this.me] === 0) this.over = { win: false, reason: 'lost' };
    else if (this.counts[this.me] >= need) this.over = { win: true, reason: 'majority' };
    else for (let p = 1; p <= 47; p++) if (p !== this.me && this.counts[p] >= need) { this.over = { win: false, reason: 'rival', rival: p }; break; }
    if (this.over) { this.over.time = this.time; this.emit('over', this.over); }
  }

  // ---------------------------------------------------------- 砦
  canBuildFort(P, c) {
    if (c < 0 || c >= this.map.N || !this.map.initPref[c]) return 'sea';
    if (this.owner[c] !== P) return 'notown';
    const W = this.map.W, x = c % W + 0.5, y = ((c / W) | 0) + 0.5;
    for (const n of this.nodes) if (Math.hypot(n.x - x, n.y - y) < CONFIG.FORT_MIN_DIST) return 'near';
    if (this.gold[P] < CONFIG.FORT_COST) return 'gold';
    return null;
  }
  /** 砦：周りのマスのうち、今の持ち主の拠点より砦のほうが近いマスを自分の領土にする（国境を押し出す） */
  buildFort(P, c, byPlayer) {
    const why = this.canBuildFort(P, c);
    if (why) return { ok: false, why };
    this.gold[P] -= CONFIG.FORT_COST;
    const k = this.nodes.filter((n) => n.type === 'fort' && n.pref === P).length + 1;
    const n = this.addNode({ cell: c, pref: P, owner: P, type: 'fort', name: `${this.map.prefs[P].short}の砦${k}` });
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
      if (di > CONFIG.FORT_RADIUS) continue;
      this.forNeighbors(i, (j) => {
        if (d.has(j) || dist[j] === 0 || di >= dist[j]) return;
        d.set(j, di); q.push(j); take(j, di);
      });
    }
    // 全国を数え直すと一瞬止まるので、砦の周りだけ更新する
    // （元の拠点の nodeCells には古いマスが残るが、使うときに nodeOf で確かめる）
    this.nodeCells.push(Int32Array.from(claimed));
    this.nodeAdj.push([]);
    const adj = new Set();
    for (const i of claimed) this.forNeighbors(i, (j) => { const b = nodeOf[j]; if (b !== n.id) adj.add(b); });
    for (const b of adj) { this.nodeAdj[n.id].push(b); if (!this.nodeAdj[b].includes(n.id)) this.nodeAdj[b].push(n.id); }
    this.stats.forts++;
    this.emit('cells', changed);
    this.emit('fort', { node: n, by: P, byPlayer, cells: changed.length });
    // 砦に押し出されて拠点を失った県はない（拠点のマスは奪わない）
    this.checkEnd();
    return { ok: true, node: n };
  }

  // ---------------------------------------------------------- プレイヤーの命令
  commandMove(x, y) {
    const u = this.player;
    if (!u || !u.alive) return false;
    u.chase = -1; u.goalNode = -1;
    this.setDest(u, x, y);
    return true;
  }
  commandFort() {
    const u = this.player;
    if (!u || !u.alive) return { ok: false, why: 'dead' };
    return this.buildFort(this.me, this.cellAt(u.x, u.y), true);
  }
  ranking() {
    const arr = [];
    for (let p = 1; p <= 47; p++) arr.push(p);
    arr.sort((a, b) => this.counts[b] - this.counts[a] || a - b);
    return arr;
  }
  rankOf(p) { return this.ranking().indexOf(p) + 1; }
  aliveUnits(p) { let n = 0; for (const u of this.units) if (u.pref === p && u.alive) n++; return n; }
}
