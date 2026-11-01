// =====================================================================
// オンライン版：サーバーとつながるゲーム。app.js からは Sim と同じ形で使う。
//   ・日本全体の持ち主は「元の地図の1マス（細かいマス3×3）」ごとに受け取る（owner / isRecent）
//   ・画面の周りは細かいマスの持ち主を 64×64 マスの区画で受け取り、描画の細かい層に入れる
//   ・兵士・建物は画面に映っている範囲だけ 0.5 秒ごとに届く（兵士は前回の位置から補間して動かす）
// =====================================================================
const NET_SNAP = 0.5;
const NET_TYPES = BUILD_ORDER, NET_UNIT_TYPES = Object.keys(UNITS);
const NET_NODE_TYPES = ['capital', 'town', 'fort', 'castle'];

/** 元の地図を S 倍に細かくした座標で扱う（中身は元の地図のまま。座標 → 元のマス） */
function scaledMap(c, S) {
  const m = Object.create(c);
  m.W = c.W * S; m.H = c.H * S; m.scale = S; m.texScale = S; m.coarse = c;
  m.id = (x, y) => c.id(Math.floor(x / S), Math.floor(y / S));
  m.X = (i) => c.X(i) * S + (S >> 1);
  m.Y = (i) => c.Y(i) * S + (S >> 1);
  m.landCells = c.landCells * S * S;
  m.initCounts = c.initCounts.map((v) => v * S * S);
  m.elevScale = c.elevScale * S;
  m.raw = { ...c.raw, insets: c.raw.insets.map((r) => ({ ...r, poly: r.poly.map((v) => v * S) })) };
  m.lonLat = (x, y) => c.lonLat(x / S, y / S);
  return m;
}

class NetGame {
  constructor(app, url) {
    this.app = app; this.map = app.map; this.url = url;
    const N = this.map.N;
    this.owner = this.map.initPref.slice();          // 元の地図の1マスごとの持ち主
    this.recentC = new Uint8Array(N);
    this.listeners = {};
    this.nodes = []; this.units = []; this.unitIndex = new Map(); this.buildings = []; this.bmap = new Map(); this.shots = [];
    this.time = 0; this.acc = 0; this.snapAt = 0; this.clock = 0;
    this.pop = new Float64Array(49); this.counts = new Int32Array(49); this.nodeCount = new Int32Array(49);
    this.parts = new Int32Array(49); this.unitsBy = new Int32Array(49); this.capsBy = new Int32Array(49); this.bldsBy = new Int32Array(49);
    this.humansIn = new Int32Array(49);
    this.popTotal = 1;
    this.res = { food: [0], wood: [0], gold: [0] };
    this.income = { food: 0, wood: 0, gold: 0 };
    this.rally = -1; this.over = null; this.myB = 0; this.myU = 0; this.online = 0;
    this.subs = new Set(); this.viewKey = ''; this.viewT = 0;
    this.stats = { captures: 0, trainedMine: 0 };
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, ...a) { const l = this.listeners[ev]; if (l) for (const f of l) f(...a); }
  dispose() { this.closed = true; this.listeners = {}; if (this.ws) try { this.ws.close(); } catch (e) { /* 無視 */ } }

  /** つないで、県を選んで参加する（同じ端末なら前回の参加を続ける） */
  join(pref, name) {
    this.wantPref = pref; this.name = name;
    return new Promise((resolve, reject) => {
      this.onWelcome = resolve;
      this.onFail = reject;
      this.connect();
    });
  }
  connect() {
    let token = null;
    try { token = localStorage.getItem('jinchi47_token'); } catch (e) { /* 使えない環境 */ }
    const ws = this.ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', token, pref: this.wantPref, name: this.name }));
    ws.onmessage = (e) => { try { if (typeof e.data === 'string') this.onJson(JSON.parse(e.data)); else this.onBinary(e.data); } catch (err) { console.error(err); } };
    ws.onclose = () => {
      if (this.closed) return;
      if (this.onFail && !this.welcomed) { this.onFail(new Error('サーバーにつながりません')); this.onFail = null; return; }
      this.emit('net', 'down');
      setTimeout(() => { if (!this.closed) this.connect(); }, 2000);
    };
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }

  // ------------------------------------------------ 受信
  onJson(m) {
    switch (m.t) {
      case 'welcome': {
        try { localStorage.setItem('jinchi47_token', m.token); } catch (e) { /* 使えない環境 */ }
        this.w = m.w; this.me = m.pref; this.S = m.S; this.fineTW = m.fineTW; this.fineTH = m.fineTH; this.popTotal = m.popTotal;
        this.nodes = [];
        for (const r of m.nodes) this.nodeFrom(r);
        // つなぎ直したときは細かい区画を受け取り直す
        for (const t of this.subs) this.app.renderer.dropFine(t);
        this.subs.clear(); this.viewKey = '';
        this.app.renderer.initFine(m.fineTW, m.fineTH);
        const first = !this.welcomed;
        this.welcomed = true;
        if (first && this.onWelcome) { this.onWelcome(m); this.onWelcome = null; }
        else this.emit('net', 'up');
        break;
      }
      case 'error':
        if (this.onFail && !this.welcomed) { this.onFail(new Error(m.why === 'eliminated' ? 'その県はもう脱落しています' : '参加できません')); this.onFail = null; this.closed = true; this.ws.close(); }
        break;
      case 'stats': {
        this.time = m.time; this.clock = 0;
        for (let p = 1; p <= 47; p++) {
          this.pop[p] = m.pop[p]; this.counts[p] = m.counts[p]; this.nodeCount[p] = m.nodeCount[p];
          this.parts[p] = m.parts[p]; this.unitsBy[p] = m.units[p]; this.capsBy[p] = m.caps[p]; this.bldsBy[p] = m.blds[p]; this.humansIn[p] = m.humans[p];
        }
        for (const r of RES_KEYS) this.res[r][0] = m.res[r];
        if (m.income) this.income = m.income;
        this.myB = m.myB; this.myU = m.myU; this.rally = m.rally; this.online = m.online;
        this.flagOrder = m.fo ? { x: m.fo[0], y: m.fo[1], flag: m.fo[2] ? { id: m.fo[2] } : null } : null;
        if (m.over && !this.over) this.setOver(m.over);
        break;
      }
      case 'reset':   // 新しいシーズンが始まった
        try { localStorage.removeItem('jinchi47_token'); } catch (e) { /* 使えない環境 */ }
        this.closed = true;
        setTimeout(() => location.reload(), 500);
        break;
      case 'nodes':
        for (const r of m.n) this.nodeFrom(r);
        break;
      case 'snap': this.onSnap(m); break;
      case 'ev': for (const e of m.e) this.onEvent(e); break;
      case 'buildres':
        if (!m.ok) this.emit('buildfail', m);
        break;
    }
  }
  nodeFrom(r) {
    const [id, x, y, pref, owner, type, name, cells, wallet, capturedAt, pct, capBy, att, def] = r;
    let n = this.nodes[id];
    if (!n) n = this.nodes[id] = { id, progress: 0, capBy: 0, attackers: 0, defenders: 0 };
    n.x = x / 10; n.y = y / 10; n.pref = pref; n.owner = owner; n.type = NET_NODE_TYPES[type]; n.name = name; n.cells = cells;
    n.wallet = wallet; n.byPlayer = wallet === this.w; n.capturedAt = capturedAt; n.cell = this.map.id(n.x, n.y);
    if (pct !== undefined) { n.progress = pct / 1000 * this.needFor(n); n.capBy = capBy; n.attackers = att; n.defenders = def; }
  }
  setOver(o) {
    const top = o.winner || (this.ranking()[0]);
    const reason = o.reason === 'lost' || o.reason === 'season' ? o.reason : (top === this.me ? 'majority' : 'rival');
    this.over = { win: o.reason !== 'lost' && top === this.me, reason, rival: top, time: this.time };
    this.emit('over', this.over);
  }
  onEvent(e) {
    if (e.k === 'capture') {
      const n = this.nodes[e.node];
      if (!n) return;
      this.stats.captures++;
      this.emit('capture', { node: n, from: e.from, by: e.by, cells: n.cells });
    } else if (e.k === 'elim') { this.emit('eliminated', e.p); if (e.p === this.me && !this.over) this.setOver({ reason: 'lost' }); }
    else if (e.k === 'built') this.emit('built', { byPlayer: true, type: e.type, building: { cell: this.map.id(e.x, e.y) } });
    else if (e.k === 'destroyed') {
      const b = { owner: this.me, type: e.type, cell: this.map.id(e.x, e.y) };
      this.emit('destroyed', b);
    } else if (e.k === 'over') this.setOver(e.o);
    else if (e.k === 'flag') this.emit('flag', { kind: e.kind, flag: { ...e.f, hw: e.f.hw === this.w ? 0 : -1 }, cells: e.cells });
  }
  onSnap(m) {
    this.snapAt = this.clock;
    this.acc = 0;
    if (m.u) {
      const old = this.unitIndex, idx = new Map(), list = [], U = m.u;
      for (let k = 0; k < U.length; k += 8) {
        const id = U[k], x = U[k + 1] / 10, y = U[k + 2] / 10, f = U[k + 5];
        let u = old.get(id);
        if (u) { u.px = u.x; u.py = u.y; } else u = { id, px: x, py: y };
        u.x = x; u.y = y; u.pref = U[k + 3]; u.hp = U[k + 4];
        u.engaged = f & 1 ? U[k + 6] : -1; u.hitB = f & 2 ? true : null; u.fromPlayer = !!(f & 8); u.alive = true; u.type = NET_UNIT_TYPES[U[k + 7]] || 'ashigaru';
        idx.set(id, u); list.push(u);
      }
      this.units = list; this.unitIndex = idx;
      const D = m.d || [];
      for (let k = 0; k < D.length; k += 4) this.emit('death', { x: D[k] / 10, y: D[k + 1] / 10, pref: D[k + 2], id: D[k + 3] });
      this.shots = (m.s || []).map((s) => s.map((q) => q / 10));
      this.flags = (m.f || []).map(([id, x, y, pref, prog, hp, own, hw]) => ({ id, x: x / 10, y: y / 10, pref, prog, hp, own, hw: hw === this.w ? 0 : -1 }));
      this.gas = (m.g || []).map(([x, y, r, left]) => ({ x: x / 10, y: y / 10, r, until: this.time + left }));
      this.booms = (m.x || []).map(([x, y, r, k, ox, oy, t]) => [x / 10, y / 10, r, t / 10, k, ox / 10, oy / 10]);
    } else if (this.units.length) { this.units = []; this.unitIndex = new Map(); this.shots = []; }
    let changed = false;
    for (const r of m.ba || []) {
      const [id, type, x, y, owner, hp, maxHp, rot, mine, mul, forest, t] = r;
      const b = { id, type: NET_TYPES[type], x: x / 10, y: y / 10, owner, hp, maxHp, rot: rot / 100, wallet: mine ? 0 : -1, byPlayer: !!mine, mul, forest, t };
      b.cell = this.map.id(b.x, b.y);
      this.bmap.set(id, b); changed = true;
    }
    for (const [id, owner, mine, hp, t, hit] of m.bu || []) {
      const b = this.bmap.get(id);
      if (!b) continue;
      b.owner = owner; b.wallet = mine ? 0 : -1; b.hp = hp; b.t = t;
      if (hit) b.hitAt = this.time;
    }
    for (const id of m.bd || []) {
      const b = this.bmap.get(id);
      if (b) { b.dead = true; this.bmap.delete(id); changed = true; }
    }
    if (changed) this.buildings = [...this.bmap.values()];
  }
  /** 持ち主の区画：1=日本全体（粗い）, 2=粗い区画1つ, 3=細かい区画1つ */
  onBinary(buf) {
    const u8 = new Uint8Array(buf), kind = u8[0], idx = u8[1] | (u8[2] << 8) | (u8[3] << 16) | (u8[4] << 24);
    const body = u8.subarray(5);
    const runs = (fn) => {
      let p = 0, o = 0;
      while (p < body.length) {
        const v = body[p++];
        let len = 0, shift = 0, b;
        do { b = body[p++]; len |= (b & 127) << shift; shift += 7; } while (b & 128);
        fn(o, len, v); o += len;
      }
    };
    const R = this.app.renderer, ip = this.map.initPref;
    // 持ち主の値：0 = 元の県のまま、1〜47 = 占領した県。+64 = 最近占領された
    if (kind === 1 || kind === 2) {
      const base = kind === 1 ? 0 : idx << 12;
      runs((o, len, v) => {
        const a = base + o, b = a + len, own = v & 63;
        if (own) this.owner.fill(own, a, b); else this.owner.set(ip.subarray(a, b), a);
        this.recentC.fill(v >> 6 & 1, a, b);
      });
      if (kind === 1) R.attachGame(this, this.me); else R.tileChanged(idx);
      this.app.minimapDirty = true;
    } else if (kind === 3) {
      if (!this.subs.has(idx)) return;
      const out = new Uint8Array(4096);
      runs((o, len, v) => out.fill(v, o, o + len));
      const x0 = (idx % this.fineTW) * 64, y0 = ((idx / this.fineTW) | 0) * 64;
      for (let k = 0; k < 4096; k++) {
        if (out[k] & 63) continue;
        const ci = this.map.id(x0 + (k & 63), y0 + (k >> 6));
        if (ci >= 0 && ip[ci]) out[k] |= ip[ci];
      }
      R.setFineTile(idx, out);
    }
  }

  // ------------------------------------------------ 毎フレーム
  update(dt) {
    this.clock += dt;
    this.time += dt * (this.speed || 1);
    this.acc = clamp((this.clock - this.snapAt) / NET_SNAP, 0, 1) * CONFIG.TICK;
    this.viewT -= dt;
    if (this.viewT <= 0 && this.welcomed) { this.viewT = 0.3; this.sendView(); }
  }
  /** 画面に映っている範囲をサーバーへ。拡大しているときは細かい区画も受け取る */
  sendView() {
    const app = this.app, cam = app.cam;
    const pts = [[0, 0], [app.w, 0], [0, app.h], [app.w, app.h], [app.w / 2, 0]].map(([x, y]) => cam.groundAt(x, y)).filter(Boolean);
    if (!pts.length) return;
    const cx = cam.tx, cz = cam.tz, far = cam.dist * 3;
    const xs = pts.map((p) => clamp(p.x, cx - far, cx + far)), zs = pts.map((p) => clamp(p.z, cz - far, cz + far));
    const x0 = Math.floor(Math.min(...xs)), x1 = Math.ceil(Math.max(...xs)), y0 = Math.floor(Math.min(...zs)), y1 = Math.ceil(Math.max(...zs));
    const cpx = cam.cellPx();
    const u = cpx > 0.25, b = cpx > 0.3;
    const key = `${x0 >> 4},${y0 >> 4},${x1 >> 4},${y1 >> 4},${u},${b}`;
    if (key !== this.viewKey) { this.viewKey = key; this.send({ t: 'view', x0, y0, x1, y1, u, b }); }
    // 細かい区画：画面の中心に近い順に最大 400 区画
    const want = new Set();
    if (cpx >= 1.2) {
      const tx0 = Math.max(0, x0 >> 6), tx1 = Math.min(this.fineTW - 1, x1 >> 6), ty0 = Math.max(0, y0 >> 6), ty1 = Math.min(this.fineTH - 1, y1 >> 6);
      const list = [];
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
        if (!this.fineHasLand(tx, ty)) continue;   // 元の地図で陸地を含まない区画はいらない
        list.push([(tx * 64 + 32 - cx) ** 2 + (ty * 64 + 32 - cz) ** 2, ty * this.fineTW + tx]);
      }
      list.sort((p, q) => p[0] - q[0]);
      for (let k = 0; k < Math.min(400, list.length); k++) want.add(list[k][1]);
    }
    const add = [], del = [];
    for (const t of want) if (!this.subs.has(t)) { add.push(t); this.subs.add(t); }
    for (const t of this.subs) if (!want.has(t)) { del.push(t); }
    // 少し離れただけで捨てないよう、要らなくなった区画が多いときだけ捨てる
    if (del.length > 120 || (!want.size && del.length)) for (const t of del) { this.subs.delete(t); this.app.renderer.dropFine(t); }
    else del.length = 0;
    if (add.length || del.length) this.send({ t: 'sub', add, del });
  }

  fineHasLand(tx, ty) {
    const c = this.map.coarse, S = this.S;
    const cx0 = ((tx * 64 / S) | 0) >> 6, cx1 = ((((tx + 1) * 64 - 1) / S) | 0) >> 6;
    const cy0 = ((ty * 64 / S) | 0) >> 6, cy1 = ((((ty + 1) * 64 - 1) / S) | 0) >> 6;
    for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) if (x < c.TW && y < c.TH && c.tileBase[y * c.TW + x] >= 0) return true;
    return false;
  }

  // ------------------------------------------------ Sim と同じ問い合わせ
  isRecent(i) { return this.recentC[i] === 1; }
  needFor(n) { return CONFIG.CAPTURE_NEED[n.type]; }
  cellsOf(id) { const n = this.nodes[id]; return { length: n ? n.cells : 0 }; }
  canAfford(w, cost) { for (const r of RES_KEYS) if ((cost[r] || 0) > this.res[r][0]) return false; return true; }
  myBuildings() { return this.myB; }
  myUnits() { return this.myU; }
  unitCount(p) { return this.unitsBy[p]; }
  unitCap(p) { return this.capsBy[p]; }
  ranking() {
    const arr = [];
    for (let p = 1; p <= 47; p++) arr.push(p);
    arr.sort((a, b) => this.pop[b] - this.pop[a] || this.counts[b] - this.counts[a] || a - b);
    return arr;
  }
  rankOf(p) { return this.ranking().indexOf(p) + 1; }
  buildingsNear(x, y, r, fn) { for (const b of this.buildings) { const d = Math.hypot(b.x - x, b.y - y); if (d <= r) fn(b, d); } }
  setRally(id) { this.rally = id; this.send({ t: 'rally', node: id }); }
  setFlagOrder(pt) {
    if (pt) { const c = this.map.id(pt.x, pt.y); if (c < 0 || !this.map.initPref[c]) return false; }
    this.flagOrder = pt ? { x: pt.x, y: pt.y, flag: null } : null;
    this.send({ t: 'flagorder', x: pt ? pt.x : null, y: pt ? pt.y : null });
    return true;
  }
  /** 建設はサーバーが判断する（だめなときは 'buildfail' が届く） */
  playerBuild(type, i, x, y) {
    if (!this.canAfford(0, BUILDINGS[type].cost)) return { ok: false, why: 'cost' };
    if (i < 0 || !this.map.initPref[i]) return { ok: false, why: 'sea' };
    if (this.owner[i] !== this.me) return { ok: false, why: 'notown' };
    this.send({ t: 'build', type, x, y });
    for (const r of RES_KEYS) this.res[r][0] -= BUILDINGS[type].cost[r] || 0;   // 次の知らせが届くまでの見込み
    return { ok: true, pending: true };
  }
}
