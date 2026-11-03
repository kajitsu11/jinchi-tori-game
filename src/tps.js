// =====================================================================
// 三人称視点：あなたは「大将」を背中越しに操作する（移動・建築・旗・作戦）。
// 地図ビュー（斜め／真上）は見るだけ：大将の操作や建物の設置はできない
// =====================================================================
const TPS = {
  H: 0.42,          // 三人称視点での兵の背の高さ（建物と釣り合う大きさ）
  FOV: 55,          // 視野角（地図ビューより広く）
  PITCH: 13, PMIN: 2, PMAX: 62,
  DIST: 2.6, DMIN: 1.2, DMAX: 9,
  R: 120,           // これより遠いものは描かない（霧に溶ける）
  REACH: 2.9,       // 建物を置く場所（大将の前、何マス先か）
  FOG: { start: 22, end: 105, col: [0.79, 0.84, 0.86], top: [0.36, 0.56, 0.8] },
};

Object.assign(App, {
  /** 大将を操作できるか（オンライン版は地図ビューだけ） */
  hasTps() { return !ONLINE && !!(this.game && this.game.moveGeneral && CONFIG.PLAYER_GENERAL); },
  isTps() { return this.view === 'tps' && this.state === STATE.PLAYING && !this.iconStub; },

  /** 'tps'（大将の視点）か 'map'（地図を見るだけ） */
  setView(v) {
    if (v === 'tps' && !this.hasTps()) v = 'map';
    const prev = this.view;
    this.view = v;
    const B = document.body.classList;
    B.toggle('v-tps', v === 'tps'); B.toggle('v-map', v === 'map' && this.hasTps());
    const cam = this.cam, g = this.game;
    if (this.keys) this.keys.clear();
    this.joyV = [0, 0];
    if (v === 'map') {
      this.endBuild();
      if (this.setMode) this.setMode(null);
      cam.yaw = 0; cam.ty = 0; cam.fovY = CONFIG.FOV * Math.PI / 180; cam.minDist = 0; cam.nearMin = 0;
      cam.pitch = cam.pitchGoal = this.topView ? CONFIG.TOP_PITCH : CONFIG.CAMERA_PITCH;
      if (prev === 'tps') {
        const gen = g && g.general;
        const x = gen ? gen.x : cam.tx, z = gen ? gen.y : cam.tz;
        cam.dist = 40 * (this.map.scale || 1) / 3 + 20; cam.tx = x; cam.tz = z;
        cam.flyTo(x, z, 150 * (this.map.scale || 1) / 3 + 60, 0.5);
      }
    } else {
      this.hidePanel && this.hidePanel();
      if (this.setMode) this.setMode(null);
      cam.goal = null;
      cam.fovY = TPS.FOV * Math.PI / 180; cam.minDist = TPS.DMIN; cam.nearMin = 0.04;
      if (!this.tps) this.tps = { yaw: 0, pitch: TPS.PITCH, dist: TPS.DIST };
      this.tpsSnap = true;
    }
    if (this.state === STATE.PLAYING && this.mission !== undefined && this.hudReady) this.updateHud(true);
  },

  /** 毎フレーム：大将を動かし、カメラを背中の後ろへ */
  tpsUpdate(dt) {
    if (!this.isTps()) return;
    const g = this.game, cam = this.cam, map = this.map, T = this.tps;
    const gen = g.general && g.general.alive ? g.general : null;
    const sy = Math.sin(T.yaw), cy = Math.cos(T.yaw);
    const fx = -sy, fz = -cy, rx = cy, rz = -sy;   // 地面の上の前と右
    // 入力：スティック＋キー（WASD・矢印）
    let ix = this.joyV ? this.joyV[0] : 0, iy = this.joyV ? -this.joyV[1] : 0, run = this.joyRun;
    if (this.keys && this.keys.size && !this.paused) {
      for (const k of this.keys) {
        if (k === 'w' || k === 'W' || k === 'ArrowUp') iy += 1;
        if (k === 's' || k === 'S' || k === 'ArrowDown') iy -= 1;
        if (k === 'a' || k === 'A' || k === 'ArrowLeft') ix -= 1;
        if (k === 'd' || k === 'D' || k === 'ArrowRight') ix += 1;
        if (k === 'Shift') run = true;
        if (k === 'q' || k === 'Q') T.yaw += dt * 2.2;
        if (k === 'e' || k === 'E') T.yaw -= dt * 2.2;
      }
    }
    // 大将が（復活して）現れたら、城の門の前に立たせ、城の方を向く
    if (gen && gen !== this.tpsGen) {
      this.tpsGen = gen;
      const S0 = map.scale || 1, big = 0.9 * 1.15, oz = 4.6 * big;
      if (map.isLand(map.id(Math.floor(gen.x), Math.floor(gen.y + oz)))) gen.y += oz;
      gen.px = gen.x; gen.py = gen.y;
      T.yaw = 0; this.tpsSnap = true;
      void S0;
    }
    const mag = Math.min(1, Math.hypot(ix, iy));
    if (gen && mag > 0.08 && !this.paused) {
      const S = map.scale || 1;
      const sp = (0.55 + 0.4 * S) * (run ? 1.75 : 1) * mag * dt;
      const n = Math.hypot(ix, iy) || 1, dx = (rx * ix + fx * iy) / n, dz = (rz * ix + fz * iy) / n;
      const land = (x, z) => { const i = map.id(Math.floor(x), Math.floor(z)); return i >= 0 && map.isLand(i); };
      let nx = gen.x + dx * sp, nz = gen.y + dz * sp;
      if (!land(nx, nz)) {   // 海には入れない：岸に沿ってすべる
        if (land(gen.x + dx * sp, gen.y)) nz = gen.y;
        else if (land(gen.x, gen.y + dz * sp)) nx = gen.x;
        else { nx = gen.x; nz = gen.y; }
      }
      gen.x = nx; gen.y = nz;
      this.genMoving = true;
    } else this.genMoving = false;
    if (gen) { gen.px = gen.x; gen.py = gen.y; gen.dest = null; gen.path = null; }
    // カメラ：大将の右肩の後ろ
    const H = TPS.H;
    const tx = gen ? gen.x : (this.tpsLast ? this.tpsLast[0] : cam.tx), tz = gen ? gen.y : (this.tpsLast ? this.tpsLast[1] : cam.tz);
    this.tpsLast = [tx, tz];
    const sh = H * 0.55 * Math.min(1, T.dist / 3);
    let gx = tx + rx * sh, gz = tz + rz * sh;
    // 建築中は、大将と設計図の間を見る（下のカードに隠れないように、少し先を画面の真ん中に）
    const bk0 = this.buildK || 0;
    if (bk0 > 0 && gen) { gx += -sy * TPS.REACH * 0.7 * bk0; gz += -cy * TPS.REACH * 0.7 * bk0; }
    const k = this.tpsSnap ? 1 : Math.min(1, dt * 12);
    this.tpsSnap = false;
    cam.goal = null;
    cam.tx += (gx - cam.tx) * k; cam.tz += (gz - cam.tz) * k;
    cam.ty = H * 1.35;
    // 建築中は少し引いて見下ろす（置く場所と周りが見えるように）
    this.buildK = (this.buildK || 0) + ((this.build ? 1 : 0) - (this.buildK || 0)) * Math.min(1, dt * 6);
    const bk = this.buildK;
    cam.yaw = T.yaw; cam.pitch = cam.pitchGoal = clamp(T.pitch + bk * 12, TPS.PMIN, 75); cam.dist = T.dist * (1 + bk * 0.7);
    cam.fovY = TPS.FOV * Math.PI / 180; cam.minDist = TPS.DMIN; cam.nearMin = 0.04;
    this.ghostUpdate();
    this.genHud(gen);
  },
  /** 大将の体力・レベルと、今いる場所（自県／敵の領土） */
  genHud(gen) {
    const g = this.game, bar = $('gh-bar'), where = $('gh-where');
    const f = gen ? clamp(gen.hp / UNITS.general.hp, 0, 1) : 0;
    const w = Math.round(f * 100);
    if (w !== this.ghW) { this.ghW = w; bar.style.width = w + '%'; bar.className = f > 0.6 ? '' : f > 0.3 ? 'mid' : 'low'; }
    const lv = `Lv${g.genLv || 1}`;
    if (lv !== this.ghLv) { this.ghLv = lv; $('gh-lv').textContent = lv; }
    let txt = '', cls = '';
    if (!gen) txt = '県庁で立て直し中';
    else {
      const own = g.owner[g.cellAt(gen.x, gen.y)], P = this.map.prefs[own];
      if (own === this.me) txt = `<i style="background:${P.color}"></i>自県の領土`;
      else if (P) { txt = `<i style="background:${P.color}"></i>${P.name}の領土 — 旗を立てられる`; cls = 'enemy'; }
    }
    if (txt !== this.ghTxt) { this.ghTxt = txt; where.innerHTML = txt; where.className = cls; }
  },
  /** 視点を回す（ドラッグ量 px） */
  tpsLook(dx, dy) {
    const T = this.tps;
    if (!T) return;
    T.yaw -= dx * 0.0085;
    T.pitch = clamp(T.pitch + dy * 0.18, TPS.PMIN, TPS.PMAX);
  },
  tpsZoom(f) { const T = this.tps; if (T) T.dist = clamp(T.dist * f, TPS.DMIN, TPS.DMAX); },

  // ------------------------------------------------ 建築（大将の前のマスに設計図を出して、決定で建てる）
  startBuild(type) {
    if (!this.isTps()) { this.banner('地図の画面では建てられません', 'ng', '「大将に戻る」で大将の視点にしてから建てよう'); return; }
    const t = type || (this.build && this.build.type) || this.lastBuild || BUILD_ORDER.find((k) => BUILDINGS[k].cat === (this.bcat || 'eco'));
    if (!this.build) this.build = { type: t, rotK: 0 };
    this.build.type = t; this.lastBuild = t;
    document.body.classList.add('building');
    this.menuHidden = false;
    this.buildMenu();
    for (const b of document.querySelectorAll('.bcard')) b.classList.toggle('on', b.dataset.b === t);
    this.ghostUpdate();
  },
  endBuild() {
    this.build = null; this.ghost = null;
    document.body.classList.remove('building');
    for (const b of document.querySelectorAll('.bcard')) b.classList.remove('on');
  },
  toggleBuild() { if (this.build) this.endBuild(); else this.startBuild(); },
  rotateBuild() { if (this.build) { this.build.rotK = (this.build.rotK + 1) % 4; this.ghostUpdate(); } },
  ghostUpdate() {
    const g = this.game, B = this.build;
    if (!B || !this.isTps() || !g.general || !g.general.alive) { this.ghost = null; this.updateBuildBtn(); return; }
    const gen = g.general, map = this.map, T = this.tps;
    const def = BUILDINGS[B.type];
    const reach = TPS.REACH * (def.node ? 1.5 : 1);
    const x = Math.floor(gen.x - Math.sin(T.yaw) * reach), z = Math.floor(gen.y - Math.cos(T.yaw) * reach);
    const cell = map.id(x, z);
    // 正面（戸のある側）を大将の方へ向け、90度ずつ回せる
    const rot = Math.round(-T.yaw / (Math.PI / 2)) * (Math.PI / 2) + B.rotK * Math.PI / 2;
    const why = cell < 0 ? 'sea' : g.canBuild(B.type, this.me, cell, 0);
    if (!this.ghost || this.ghost.cell !== cell || this.ghost.rot !== rot || this.ghost.type !== B.type) {
      this.ghost = { cell, type: B.type, rot, x: x + 0.5, z: z + 0.5, why,
        b: { id: -7, type: B.type, cell, x: x + 0.5, y: z + 0.5, owner: this.me, wallet: 0, hp: 1, maxHp: 1, rot, t: 0, mul: 1, forest: 10, ghost: true } };
    }
    this.ghost.why = why;
    this.updateBuildBtn();
  },
  updateBuildBtn() {
    const el = $('bc-place');
    if (!el) return;
    const G = this.ghost, ok = G && !G.why;
    el.classList.toggle('ng', !ok);
    const lab = el.querySelector('span');
    if (lab) lab.textContent = document.body.classList.contains('land') ? (ok ? '建てる' : '置けない')   // 横画面は丸いボタン（理由は設計図の上に出る）
      : !G ? '置けません' : ok ? `${BUILDINGS[G.type].name}を建てる` : this.buildWhy(G.why);
  },
  buildWhy(why) {
    return { sea: '海には置けない', notown: '自県の領土の外', crowded: '近くに建物がある', nearnode: '拠点に近すぎる', terrain: '地形が合わない',
      noforest: '森の近くに置こう', cost: '資源が足りない', nomountain: '山の近くに置こう', nocoast: '海の近くに置こう' }[why] || '置けません';
  },
  placeBuild() {
    const G = this.ghost, g = this.game;
    if (!G) return;
    if (G.why) { this.showBuildFail(G.why); Sfx.alert && Sfx.alert(); return; }
    const r = g.playerBuild(G.type, G.cell);
    if (r.ok) {
      if (r.building) r.building.rot = G.rot;
      this.marker = { x: G.x, z: G.z, t: this.clock, ok: true };
      Sfx.boom && Sfx.boom(0.25);
      this.ghost = null; this.ghostUpdate();
    } else this.showBuildFail(r.why);
    this.updateHud(true);
  },

  // ------------------------------------------------ 旗・作戦（大将のいる場所で）
  tpsFlag() {
    const g = this.game, gen = g.general;
    if (!gen || !gen.alive) { this.banner('大将はいま県庁で立て直し中', 'ng', `あと${this.fmtDur(Math.max(0, (g.generalAt || 0) - g.time))}で復活`); return; }
    const own = g.owner[g.cellAt(gen.x, gen.y)];
    if (own === this.me) {
      if (g.setFlagOrder({ x: gen.x, y: gen.y })) { this.banner('敵の旗を倒しに行け！', 'ok', '正方形の中の敵の兵を倒せば、旗は消えます'); this.updateHud(true); return; }
      this.banner('ここは自県の領土', 'ng', '敵の領土まで進んでから旗を立てよう（敵の旗の近くなら迎撃）');
      return;
    }
    if (!own) { this.banner('ここには立てられません', 'ng', ''); return; }
    const f = g.plantFlagAt(this.me, gen.x, gen.y, 0);
    if (!f) { this.banner('ここには立てられません', 'ng', 'ほかの旗の正方形と重なっています'); return; }
    if (g.setFlagOrder({ x: f.x, y: f.y }, 0) && g.flagOrder) g.flagOrder.flag = f;
    this.banner('旗を立てた！', 'ok', `正方形の中で仲間と${this.fmtDur(CONFIG.FLAG_HOLD)}守り抜け`);
    Sfx.fanfare && Sfx.fanfare();
    this.updateHud(true);
  },
  /** 作戦の目標の場所：大将の視線の先 */
  aimPoint(far) {
    const g = this.game, gen = g && g.general, T = this.tps;
    if (!this.isTps() || !gen || !gen.alive) return { x: this.cam.tx, z: this.cam.tz };
    const d = far ? 9 * (this.map.scale || 1) / 3 + 3 : 0;
    return { x: gen.x - Math.sin(T.yaw) * d, z: gen.y - Math.cos(T.yaw) * d };
  },

  // ------------------------------------------------ 画面の向き
  // 基本は横画面。縦に持っているときは画面全体を90度回して横で表示する（縦画面に切り替えることもできる）
  orientPref() {
    if (window.JINCHI_ORIENT) return window.JINCHI_ORIENT;
    try { return localStorage.getItem('jinchi.orient') || 'land'; } catch (e) { return 'land'; }
  },
  applyOrient() {
    const W = window.innerWidth, H = window.innerHeight, coarse = matchMedia('(pointer: coarse)').matches;
    const pref = this.orient || (this.orient = this.orientPref());
    let rot = 0;
    if (pref === 'land' && H > W) rot = 1;                  // 縦に持っている → 回して横画面に
    else if (pref === 'port' && W > H && coarse) rot = -1;  // 横に持っているが縦画面を選んだ
    this.rot = rot;
    const B = document.body.classList, st = document.body.style;
    B.toggle('rot90', rot === 1); B.toggle('rotm90', rot === -1);
    B.toggle('land', pref === 'land');
    B.toggle('can-orient', coarse || H > W || !!window.JINCHI_ORIENT);
    const aw = rot ? H : W, ah = rot ? W : H;
    st.setProperty('--vw', W + 'px'); st.setProperty('--vh', H + 'px');
    st.setProperty('--aw', aw + 'px'); st.setProperty('--ah', ah + 'px'); st.setProperty('--appw', aw + 'px');
    for (const el of document.querySelectorAll('.or-lab')) el.textContent = pref === 'land' ? '縦画面' : '横画面';
    this.w = aw; this.h = ah;
  },
  toggleOrient() {
    this.orient = this.orient === 'land' ? 'port' : 'land';
    try { localStorage.setItem('jinchi.orient', this.orient); } catch (e) { /* 保存できない環境 */ }
    window.JINCHI_ORIENT = null;
    this.resize();
    if (this.state === STATE.TITLE) this.resetCamera(true);
  },
  /** 画面（ブラウザ）の座標 → ゲーム画面の座標（回しているとき） */
  toApp(cx, cy) {
    const r = this.rot;
    if (!r) return [cx, cy];
    return r === 1 ? [cy, window.innerWidth - cx] : [window.innerHeight - cy, cx];
  },
  vecToApp(dx, dy) { const r = this.rot; return !r ? [dx, dy] : r === 1 ? [dy, -dx] : [-dy, dx]; },
  /** 要素のゲーム画面の中での位置と大きさ */
  appRect(el) {
    let x = 0, y = 0, e = el;
    while (e && e.id !== 'app') { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    return { left: x, top: y, width: el.offsetWidth, height: el.offsetHeight };
  },

  // ------------------------------------------------ 入力（スティック）
  setupTpsInput() {
    const joy = $('joy'), knob = joy.firstElementChild;
    let id = null, c0 = null;
    const R = 46;
    const set = (e) => {
      let [dx, dy] = this.vecToApp(e.clientX - c0[0], e.clientY - c0[1]);   // 画面を回しているときは向きを直す
      const d = Math.hypot(dx, dy);
      if (d > R) { dx *= R / d; dy *= R / d; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      this.joyV = [dx / R, dy / R];
      this.joyRun = d > R * 1.25;   // 外まで倒すと走る
    };
    joy.addEventListener('pointerdown', (e) => {
      e.preventDefault(); joy.setPointerCapture(e.pointerId); id = e.pointerId;
      const r = joy.getBoundingClientRect(); c0 = [r.left + r.width / 2, r.top + r.height / 2];
      joy.classList.add('on'); set(e);
    });
    joy.addEventListener('pointermove', (e) => { if (e.pointerId === id) set(e); });
    const up = (e) => { if (e.pointerId !== id) return; id = null; this.joyV = [0, 0]; this.joyRun = false; knob.style.transform = ''; joy.classList.remove('on'); };
    joy.addEventListener('pointerup', up); joy.addEventListener('pointercancel', up);
    $('bc-rot').addEventListener('click', () => this.rotateBuild());
    $('bc-close').addEventListener('click', () => this.endBuild());
    for (const id of ['t-orient']) $(id).addEventListener('click', () => this.toggleOrient());
    // 下の帯の高さ（スティックと記録をその上に置く）
    const bb = $('bottombar'), setH = () => document.body.style.setProperty('--bbh', bb.offsetHeight + 'px');
    if (window.ResizeObserver) new ResizeObserver(setH).observe(bb); else window.addEventListener('resize', setH);
    setH();
    $('bc-place').addEventListener('click', () => this.placeBuild());
    $('t-build').addEventListener('click', () => this.toggleBuild());
    $('t-flag').addEventListener('click', () => this.tpsFlag());
    $('t-map').addEventListener('click', () => this.setView('map'));
    $('mb-back').addEventListener('click', () => this.setView('tps'));
    $('mb-top').addEventListener('click', () => this.toggleTop());
  },

  // ------------------------------------------------ 大将の姿（三人称視点では立体の鎧武者）
  /**
   * 前が +z。手足は付け根を原点にして下へ伸ばし（高さを負に）、前後に振る。
   * 漆塗りの胴・県の色の威し糸・大袖・兜と金の鍬形・背中の指物・腰の刀
   */
  drawGeneral3D(I, x, z, s, moved, fighting, team, H, C) {
    const r = -s.yaw, c = Math.cos(r), sn = Math.sin(r);
    const walk = moved > 1e-4 ? Math.min(1, moved / (0.02 * H)) : 0;
    s.walkK = (s.walkK || 0) + (walk - (s.walkK || 0)) * 0.2;
    const ph = s.phase * 0.55, k = s.walkK;
    const sw = Math.sin(ph) * 0.62 * k, bob = Math.abs(Math.cos(ph)) * 0.025 * k;
    const V = (mesh, lx, ly, lz, sx, sy, sz, col, r2, tilt) => I[mesh].push(x + (lx * c - lz * sn) * H, (ly + bob) * H, z + (lx * sn + lz * c) * H, sx * H, sy * H, sz * H, col, r + (r2 || 0), tilt || 0);
    const lac = [0.09, 0.08, 0.09], lac2 = [0.16, 0.14, 0.15], gold = [0.95, 0.76, 0.26], skin = [0.88, 0.7, 0.55];
    const hak = team.map((q) => q * 0.55 + 0.05), tm = team;
    I.shadow.push(x, 0.015, z, 0.55 * H, 0.01, 0.45 * H, [0, 0, 0], r);
    // 脚（袴）と足
    for (const sd of [-1, 1]) {
      const t = sw * sd;
      V('cylW', sd * 0.075, 0.47, 0, 0.14, -0.4, 0.15, hak, 0, t);
      V('box', sd * 0.075, 0.47 - Math.cos(t) * 0.43, -Math.sin(t) * 0.43 + 0.03, 0.08, 0.05, 0.14, lac);
      V('cylW', sd * 0.075, 0.25 - Math.cos(t) * 0.0, -Math.sin(t) * 0.24, 0.1, 0.12, 0.1, lac2, 0, t);   // すね当て
    }
    // 草摺（腰の板）・胴・威し糸
    V('cylW', 0, 0.38, 0, 0.36, 0.14, 0.27, lac2);
    for (let j = 0; j < 3; j++) V('box', 0, 0.4 + j * 0.045, 0.002, 0.37, 0.012, 0.28, tm);
    V('boxW', 0, 0.5, 0, 0.3, 0.3, 0.2, lac);
    for (let j = 0; j < 4; j++) V('box', 0, 0.54 + j * 0.06, 0.103, 0.29, 0.014, 0.01, tm);   // 胴の前の威し
    V('box', 0, 0.78, 0, 0.24, 0.05, 0.18, lac2);   // 胸板
    V('box', 0, 0.62, 0.105, 0.05, 0.05, 0.01, gold);   // 胴の金具
    // 腕（大袖・籠手）
    for (const sd of [-1, 1]) {
      const t = fighting ? (sd > 0 ? -1.1 + Math.sin(this.clock * 9) * 0.35 : -0.4) : -sw * sd * 0.8;
      V('cylW', sd * 0.19, 0.78, 0, 0.09, -0.3, 0.09, lac2, 0, t);
      V('box', sd * 0.205, 0.68, 0, 0.06, 0.17, 0.16, tm, 0, t * 0.6);   // 大袖（県の色）
      V('sphere', sd * 0.19, 0.78 - Math.cos(t) * 0.31 - 0.03, -Math.sin(t) * 0.31 - 0.03, 0.06, 0.06, 0.06, skin);
    }
    // 刀（右手で抜いて振る／歩くときは左腰）
    if (fighting) {
      const t = -1.1 + Math.sin(this.clock * 9) * 0.35;
      V('box', 0.19, 0.78 - Math.cos(t) * 0.31, -Math.sin(t) * 0.31, 0.015, 0.42, 0.03, [0.85, 0.87, 0.9], 0, t + 0.9);
    } else V('box', -0.17, 0.43, 0.02, 0.025, 0.04, 0.4, lac, 0, 0);
    // 首・顔・面頬
    V('cylW', 0, 0.8, 0, 0.08, 0.05, 0.08, skin);
    V('sphere', 0, 0.82, 0.005, 0.15, 0.16, 0.15, skin);
    V('box', 0, 0.84, 0.065, 0.11, 0.05, 0.03, [0.55, 0.12, 0.1]);   // 赤い面頬
    // 兜：鉢・吹返し・しころ・金の鍬形と前立
    V('sphere', 0, 0.875, 0, 0.19, 0.15, 0.2, lac);
    V('cylW', 0, 0.86, -0.01, 0.25, 0.035, 0.24, lac2);
    for (let j = 0; j < 3; j++) V('cylW', 0, 0.8 - j * 0.035, -0.02, 0.27 + j * 0.03, 0.03, 0.25 + j * 0.03, j % 2 ? tm : lac2);   // しころ
    for (const sd of [-1, 1]) V('box', sd * 0.06, 0.97, 0.1, 0.02, 0.2, 0.015, gold, sd * -0.25, -0.25);   // 鍬形（V字）
    V('sphere', 0, 0.94, 0.1, 0.05, 0.05, 0.02, gold);
    // 背中の指物（県の色の旗）
    V('cylW', 0.05, 0.62, -0.13, 0.02, 0.85, 0.02, [0.3, 0.2, 0.13]);
    V('box', 0.05, 1.12, -0.13, 0.015, 0.34, 0.22, tm, 0, 0);
    V('box', 0.05, 1.29, -0.13, 0.016, 0.04, 0.24, gold);
    // 歩くと土ぼこり
    if (moved > 0.01 && this.clock >= (s.dustAt || 0)) { s.dustAt = this.clock + 0.3; this.blast(9, x - Math.sin(s.yaw) * 0.2 * H, 0, z - Math.cos(s.yaw) * 0.2 * H, 0.25); }
  },

  // ------------------------------------------------ 描画の補助
  /** 設計図のまわりのマス目（マイクラ風）と、置けるか・理由 */
  drawGhostOverlay(ctx) {
    const G = this.ghost, cam = this.cam;
    if (!G || !this.isTps()) return;
    const v = [0, 0], ok = !G.why;
    ctx.save();
    // 建物の大きさの四角（向きつき）
    const def = BUILDINGS[G.type], hw = (def.node ? 1.6 : 1.15) * 0.72, cs = Math.cos(G.rot), sn = Math.sin(G.rot);
    const pts = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]].map(([lx, lz]) => cam.project(G.x + lx * cs - lz * sn, 0.02, G.z + lx * sn + lz * cs, [0, 0]));
    if (pts.every(Boolean)) {
      const pulse = 0.6 + 0.4 * Math.sin(this.clock * 6);
      ctx.strokeStyle = ok ? `rgba(120,255,140,${pulse})` : `rgba(255,90,70,${pulse})`;
      ctx.fillStyle = ok ? 'rgba(80,220,110,.18)' : 'rgba(240,70,50,.2)';
      ctx.lineWidth = 3;
      ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fill(); ctx.stroke();
      // 正面の印（戸の向き）
      const f = cam.project(G.x - hw * 1.25 * sn, 0.02, G.z + hw * 1.25 * cs, v);
      if (f) { ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(f[0], f[1], 4, 0, 7); ctx.fill(); }
    }
    const top = cam.project(G.x, def.node ? 1.6 : 1.0, G.z, v);
    if (top) {
      const txt = ok ? `${BUILDINGS[G.type].name}` : `✕ ${this.buildWhy(G.why)}`;
      ctx.font = '700 13px ' + getComputedStyle(document.body).getPropertyValue('--serif');
      const w = ctx.measureText(txt).width + 16;
      ctx.fillStyle = ok ? 'rgba(20,50,20,.85)' : 'rgba(70,16,10,.88)';
      ctx.strokeStyle = ok ? '#b8f0a0' : '#ffb08a'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.rect(top[0] - w / 2, top[1] - 24, w, 22); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, top[0], top[1] - 13);
    }
    ctx.restore();
  },
  /** 地面の上の正方形（旗の領域）を、辺を細かく区切って描く。カメラの後ろの部分は描かない */
  groundSquare(ctx, x, z, half, color, width) {
    const cam = this.cam, N = 28, a = [0, 0];
    ctx.save();
    ctx.strokeStyle = color; ctx.lineWidth = width || 2.5; ctx.setLineDash([9, 6]); ctx.globalAlpha *= 0.9;
    ctx.beginPath();
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]];
    for (let e = 0; e < 4; e++) {
      const [x0, z0] = corners[e], [x1, z1] = corners[e + 1];
      let pen = false;
      for (let k = 0; k <= N; k++) {
        const t = k / N, wx = x + (x0 + (x1 - x0) * t) * half, wz = z + (z0 + (z1 - z0) * t) * half;
        // 近すぎる（カメラのすぐ下・後ろ）点は飛ばす
        const ok = cam.project(wx, 0.05, wz, a) && a[0] > -this.w && a[0] < this.w * 2 && a[1] > -this.h && a[1] < this.h * 2;
        if (ok) { if (pen) ctx.lineTo(a[0], a[1]); else { ctx.moveTo(a[0], a[1]); pen = true; } } else pen = false;
      }
    }
    ctx.stroke();
    ctx.restore();
  },
  /** 大将の頭上の名前と体力（三人称視点） */
  drawGeneralTag(ctx) {
    const g = this.game, gen = g && g.general;
    if (!this.isTps()) return;
    if (!gen || !gen.alive) {
      const left = Math.max(0, (g.generalAt || 0) - g.time);
      ctx.save();
      ctx.fillStyle = 'rgba(20,10,4,.75)'; ctx.fillRect(this.w / 2 - 130, this.h * 0.42 - 26, 260, 52);
      ctx.fillStyle = '#f3d98e'; ctx.font = '800 16px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('大将は県庁で立て直し中', this.w / 2, this.h * 0.42 - 8);
      ctx.font = '600 12px sans-serif'; ctx.fillStyle = '#e8d6aa'; ctx.fillText(`あと${this.fmtDur(left)}で復活`, this.w / 2, this.h * 0.42 + 12);
      ctx.restore();
    }
  },
  /** 遠くの景色を霧に溶かす */
  fogOpt() { return this.isTps() ? TPS.FOG : null; },
  /** 画面に映る地面の範囲（三人称視点は大将のまわり） */
  viewBox(m) {
    const cam = this.cam;
    if (this.isTps()) return [cam.tx - TPS.R, cam.tz - TPS.R, cam.tx + TPS.R, cam.tz + TPS.R];
    const pts = [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]].map(([sx, sy]) => cam.groundAt(sx, sy)).filter(Boolean);
    if (pts.length < 4) return null;
    return [Math.min(...pts.map((p) => p.x)) - m, Math.min(...pts.map((p) => p.z)) - m, Math.max(...pts.map((p) => p.x)) + m, Math.max(...pts.map((p) => p.z)) + m];
  },
});

// テスト・デバッグ用
window.__jinchi = { App, CONFIG, STATE, TPS, get game() { return App.game; } };
App.start();
