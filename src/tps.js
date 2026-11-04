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
    if (prev !== v && this.renderer) this.resize();   // 視点ごとに描画の解像度の上限が違う
    const B = document.body.classList;
    B.toggle('v-tps', v === 'tps'); B.toggle('v-map', v === 'map' && this.hasTps());
    const cam = this.cam, g = this.game;
    if (this.keys) this.keys.clear();
    this.joyV = [0, 0];
    if (v === 'tps') this.cancelNuke && this.cancelNuke();
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
      // 近くで戦いが起きていれば、そちらを向いて始める
      let foe = null, fd = 45 * 45;
      for (const u of g.units) if (u.pref !== this.me && u.alive) { const d = (u.x - gen.x) ** 2 + (u.y - gen.y) ** 2; if (d < fd) { fd = d; foe = u; } }
      if (foe) T.yaw = Math.atan2(gen.x - foe.x, gen.y - foe.y);
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
  // ------------------------------------------------ 最強兵器（核ミサイル・調略の大鐘・大鯰の地割れ・神風の大嵐・黒死の壺・天空城）
  // 三人称視点の「兵器」ボタン → 使う兵器を選ぶ → 地図で狙う場所をタップ → 発射
  myWeapons() {
    const g = this.game;
    if (this.clock < (this.wpnScanAt || 0) && this.wpnCache) return this.wpnCache;
    this.wpnScanAt = this.clock + 0.5;
    const best = {};
    for (const b of g.buildings) {
      const k = !b.dead && b.wallet === 0 && BUILDINGS[b.type].super;
      if (k && (!best[k] || g.superReady(b) < g.superReady(best[k]))) best[k] = b;
    }
    this.wpnCache = best;
    return best;
  },
  myNuke() { return this.myWeapons().nuke || null; },
  updateNukeBtn() {
    const g = this.game, el = $('t-nuke');
    if (!el || !g || !g.superReady) return;
    const W = this.myWeapons(), kinds = Object.keys(W);
    el.classList.toggle('hidden', !kinds.length);
    if (!kinds.length) { if (!$('superpick').classList.contains('hidden')) $('superpick').classList.add('hidden'); return; }
    let ready = 0, minLeft = 1e9;
    for (const k of kinds) { const l = g.superReady(W[k]); if (l <= 0) ready++; minLeft = Math.min(minLeft, l); }
    const icon = kinds.length === 1 ? BUILDINGS[W[kinds[0]].type].icon : '⚔', lab = ready ? (kinds.length === 1 ? CONFIG.SUPER[kinds[0]].name.slice(0, 2) : '兵器') : `${Math.ceil(minLeft)}秒`;
    const key = icon + lab;
    if (key !== this.nukeLab) { this.nukeLab = key; el.querySelector('i').textContent = icon; el.querySelector('span').textContent = lab; el.classList.toggle('cool', !ready); }
    if (!$('superpick').classList.contains('hidden')) this.renderPicker();
  },
  /** 兵器ボタン：1種類ならすぐ狙う、2種類以上なら選ぶ */
  openWeapons() {
    const kinds = Object.keys(this.myWeapons());
    if (!kinds.length) { this.banner('最強兵器がありません', 'ng', '「建築」の「最強兵器」から建てよう'); return; }
    if (kinds.length === 1) { this.startSuperAim(kinds[0]); return; }
    const el = $('superpick');
    el.classList.toggle('hidden');
    if (!el.classList.contains('hidden')) this.renderPicker();
  },
  renderPicker() {
    const g = this.game, W = this.myWeapons(), order = ['nuke', 'bell', 'rift', 'storm', 'plague', 'sky'];
    const html = order.filter((k) => W[k]).map((k) => {
      const left = g.superReady(W[k]);
      return `<button data-wk="${k}" class="${left > 0 ? 'cool' : ''}"><i>${BUILDINGS[W[k].type].icon}</i><b>${CONFIG.SUPER[k].name}</b><small>${left > 0 ? `あと${Math.ceil(left)}秒` : '使える'}</small></button>`;
    }).join('');
    if (html !== this.pickHtml) { this.pickHtml = html; $('superpick').innerHTML = html; }
  },
  startNukeAim() { this.startSuperAim('nuke'); },
  startSuperAim(kind) {
    const g = this.game, b = this.myWeapons()[kind];
    $('superpick').classList.add('hidden');
    if (!b) return;
    const left = g.superReady(b), name = CONFIG.SUPER[kind].name;
    if (left > 0) { this.banner(`${name}はまだ使えません`, 'ng', `あと${this.fmtDur(left)}`); return; }
    this.setView('map');
    this.nukeAim = { kind, b, pts: [] };
    document.body.classList.add('nuking');
    $('nukebar').classList.remove('hidden'); $('nb-fire').disabled = true;
    $('nb-fire').textContent = `${BUILDINGS[b.type].icon} ${kind === 'bell' ? '鳴らす' : kind === 'sky' ? '出撃' : kind === 'plague' ? '投げ込む' : kind === 'storm' ? '呼ぶ' : kind === 'rift' ? '割る' : '発射'}`;
    const R = g.superR(kind);
    const help = {
      nuke: ['☢ 着弾地点を選ぶ', `赤い円（半径${Math.round(R)}マス）の中の兵・建物は全て消える`],
      bell: ['🔔 鐘を鳴らす場所を選ぶ', `金の円（半径${Math.round(R)}マス）の中の敵の兵・建物・土地が寝返る`],
      rift: ['🌋 地割れの始まりと終わりの2か所を選ぶ', '帯の上の兵・建物は全滅し、しばらく渡れない'],
      storm: ['🌀 大嵐を呼ぶ県を選ぶ', 'その県の土地をタップ（自県は選べない）'],
      plague: ['⚱ 壺を投げ込む場所を選ぶ', '敵の兵が多い所ほど、どんどん広がる'],
      sky: ['🏯 天空城を飛ばす先を選ぶ', '城はそこへ飛びながら真下を砲撃し続ける'],
    }[kind];
    $('nb-msg').textContent = kind === 'rift' ? '1か所目（地割れの始まり）をタップ' : '地図をタップして場所を選ぶ';
    this.cam.goal = null; this.cam.dist = Math.max(this.cam.dist, (kind === 'storm' || kind === 'sky' || kind === 'rift' ? 120 * (this.map.scale || 1) : R * 9));
    this.banner(help[0], 'ng', help[1]);
  },
  cancelNuke() {
    this.nukeAim = null;
    document.body.classList.remove('nuking');
    const bar = $('nukebar'); if (bar) bar.classList.add('hidden');
  },
  nukeTap(sx, sy) {
    const p = this.cam.groundAt(sx, sy), A = this.nukeAim, g = this.game;
    if (!p || !A) return;
    const i = this.map.id(Math.floor(p.x), Math.floor(p.z));
    if (i < 0) return;
    const o = g.owner[i], onLand = this.map.isLand(i);
    const nm = !onLand ? '海' : o === this.me ? '自県の領土' : this.map.ownerName(o) + (o === WASTE ? '' : 'の領土');
    if (A.kind === 'rift') {
      if (A.pts.length >= 2) A.pts = [];
      A.pts.push([p.x, p.z]);
      $('nb-msg').textContent = A.pts.length === 1 ? '2か所目（地割れの終わり）をタップ' : `地割れ：長さ${Math.round(Math.min(Math.hypot(A.pts[1][0] - A.pts[0][0], A.pts[1][1] - A.pts[0][1]), CONFIG.SUPER.rift.len * (this.map.scale || 1)))}マス`;
      $('nb-fire').disabled = A.pts.length < 2;
      return;
    }
    if (A.kind === 'storm' && (!onLand || o === this.me || o === WASTE || !o)) { $('nb-msg').textContent = '敵の県の土地をタップしてください'; $('nb-fire').disabled = true; A.pts = []; return; }
    A.pts = [[p.x, p.z]];
    $('nb-msg').textContent = A.kind === 'storm' ? `大嵐：${this.map.prefs[o].name}全体` : `場所：${nm}${A.kind === 'nuke' && o === this.me ? '（味方も消えます）' : ''}`;
    $('nb-fire').disabled = false;
  },
  fireNuke() {
    const A = this.nukeAim, g = this.game;
    if (!A || !A.pts.length) return;
    const [x, z] = A.pts[0], t = { x, y: z };
    if (A.kind === 'rift') { t.x2 = A.pts[1][0]; t.y2 = A.pts[1][1]; }
    const r = g.fireSuper(0, A.b, t);
    this.cancelNuke();
    this.wpnScanAt = 0;
    if (!r || !r.ok) { this.banner('使えません', 'ng', r && r.why === 'cd' ? 'まだ待ち時間があります' : r && r.why === 'target' ? 'その場所には使えません' : ''); return; }
    if (A.kind === 'nuke') this.cam.flyTo(x, z, Math.max(this.cam.dist, g.nukeRadius() * 7), 0.5);
    else if (A.kind !== 'storm') this.cam.flyTo(A.kind === 'rift' ? (x + t.x2) / 2 : x, A.kind === 'rift' ? (z + t.y2) / 2 : z, null, 0.5);
  },
  onNuke(e) {
    const map = this.map;
    (this.nukeFx || (this.nukeFx = [])).push({ ...e, t0: this.clock });
    if (e.phase === 'launch') {
      Sfx.alert();
      const mine = e.w === 0;
      this.banner(mine ? '☢ 核ミサイル発射！' : `☢ ${map.prefs[e.by].name}が核ミサイルを発射！`, 'ng', `着弾まで${Math.round(e.flight)}秒`);
      this.log(`☢ ${mine ? 'あなたが' : map.prefs[e.by].name + 'が'}核ミサイルを発射しました`, mine ? 'good' : 'bad', map.id(Math.floor(e.x), Math.floor(e.y)));
    } else {
      Sfx.boom(1); setTimeout(() => Sfx.boom(1), 250); setTimeout(() => Sfx.boom(0.8), 700);
      this.banner('☢ 着弾！ 全てが消えた', 'ng', `兵${fmt(e.killed)}人・建物${fmt(e.razed)}棟・${fmt(e.cells)}マスが焦土に`);
      this.log(`☢ 核ミサイル着弾：兵${fmt(e.killed)}人・建物${fmt(e.razed)}棟が消え、${fmt(e.cells)}マスが焦土になりました`, 'bad', map.id(Math.floor(e.x), Math.floor(e.y)));
      this.minimapDirty = true;
    }
  },
  /** 核ミサイル以外の兵器が使われた */
  onSuper(e) {
    const map = this.map, cell = map.id(Math.floor(e.x), Math.floor(e.y));
    (this.superFx || (this.superFx = [])).push({ ...e, t0: this.clock });
    this.minimapDirty = true;
    if (e.kind === 'bell') {
      Sfx.fanfare();
      this.banner('🔔 調略の大鐘が鳴り響く！', 'ok', `敵の兵${fmt(e.units)}人・拠点${e.nodes}・建物${fmt(e.blds)}棟・${fmt(e.cells)}マスが寝返った`);
      this.log(`🔔 調略の大鐘：兵${fmt(e.units)}人・拠点${e.nodes}・${fmt(e.cells)}マスが寝返りました`, 'good', cell);
    } else if (e.kind === 'rift') {
      Sfx.boom(1); setTimeout(() => Sfx.boom(0.8), 300); setTimeout(() => Sfx.boom(0.6), 700);
      this.shakeUntil = this.clock + 1.6;
      this.banner('🌋 大地が裂けた！', 'ng', `兵${fmt(e.units)}人・建物${fmt(e.blds)}棟が地割れに飲まれた（${Math.round(e.life)}秒は渡れない）`);
      this.log(`🌋 大鯰の地割れ：兵${fmt(e.units)}人・建物${fmt(e.blds)}棟が飲まれました`, 'good', cell);
    } else if (e.kind === 'storm') {
      Sfx.alert();
      this.banner(`🌀 ${map.prefs[e.pref].name}に神風の大嵐！`, 'ok', `飛行機・軍艦${fmt(e.units)}が消え、${Math.round(e.life)}秒間 足は1/3・訓練と旗が止まる`);
      this.log(`🌀 神風の大嵐：${map.prefs[e.pref].name}（飛行機・軍艦${fmt(e.units)}が消えた）`, 'good', cell);
    } else if (e.kind === 'plague') {
      Sfx.alert();
      this.banner('⚱ 黒死の壺を投げ込んだ', 'ok', `敵の兵${fmt(e.units)}人がかかった。兵から兵へ広がっていく`);
      this.log(`⚱ 黒死の壺：敵の兵${fmt(e.units)}人に疫病が広がり始めました`, 'good', cell);
    } else if (e.kind === 'sky') {
      Sfx.conch();
      this.banner('🏯 天空城、出撃！', 'ok', '城が空を飛び、真下を砲撃し続ける');
      this.log('🏯 天空城が出撃しました', 'good', cell);
    } else if (e.kind === 'skyfall') {
      Sfx.boom(1); setTimeout(() => Sfx.boom(0.8), 300);
      this.banner(e.shot ? '🏯 天空城が撃ち落とされた' : '🏯 天空城が役目を終えて落ちた', e.shot ? 'ng' : 'def', '落ちた場所の周りも吹き飛んだ');
    }
  },
  /** 地面の上の円（カメラの後ろの部分は描かない） */
  groundCircle(ctx, x, z, r) {
    const cam = this.cam, a = [0, 0], N = 72;
    ctx.beginPath();
    let pen = false, any = false;
    for (let k = 0; k <= N; k++) {
      const t = k / N * Math.PI * 2;
      const ok = cam.project(x + Math.cos(t) * r, 0.05, z + Math.sin(t) * r, a) && a[0] > -this.w && a[0] < this.w * 2 && a[1] > -this.h && a[1] < this.h * 2;
      if (ok) { if (pen) ctx.lineTo(a[0], a[1]); else { ctx.moveTo(a[0], a[1]); pen = true; } any = true; } else pen = false;
    }
    return any;
  },
  /** 続いている兵器の様子（地割れ・大嵐・疫病・天空城の体力）と、使った瞬間の演出 */
  drawSuperState(ctx) {
    const g = this.game, cam = this.cam, v = [0, 0], w2 = [0, 0], t = this.clock;
    // 地割れ：黒いギザギザの裂け目と、ふちの赤い光
    for (const r of g.rifts || []) {
      const left = r.until - g.time, fade = Math.min(1, left / 10);
      const N = 40, pts = [];
      for (let k = 0; k <= N; k++) {
        const q = k / N, x = r.x1 + (r.x2 - r.x1) * q, z = r.y1 + (r.y2 - r.y1) * q;
        const nx = -(r.y2 - r.y1) / r.L, nz = (r.x2 - r.x1) / r.L, j = (Math.sin(k * 2.7) + Math.sin(k * 7.1) * 0.5) * r.hw * 0.25;
        pts.push([x + nx * j, z + nz * j, nx, nz]);
      }
      ctx.save(); ctx.globalAlpha = fade;
      for (const [w, col] of [[r.hw * 1.0, 'rgba(120,40,10,.55)'], [r.hw * 0.55, 'rgba(20,10,8,.95)'], [r.hw * 0.15, 'rgba(255,110,30,.9)']]) {
        const side = (sgn) => pts.map(([x, z, nx, nz]) => cam.project(x + nx * w * sgn, 0.05, z + nz * w * sgn, [0, 0]));
        const A = side(1), B = side(-1);
        if (!A.every(Boolean) || !B.every(Boolean)) continue;
        ctx.beginPath(); A.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); for (let k = B.length - 1; k >= 0; k--) ctx.lineTo(B[k][0], B[k][1]); ctx.closePath();
        ctx.fillStyle = col; ctx.fill();
      }
      ctx.restore();
    }
    // 大嵐：その県の拠点の上に黒い雲の渦と稲妻。カメラがその県の中なら画面全体が暗く雨
    for (const st of g.storms || []) {
      if (st.until <= g.time) continue;
      for (const n of g.nodes) {
        if (n.owner !== st.pref || !cam.project(n.x, 0, n.y, v)) continue;
        if (v[0] < -60 || v[0] > this.w + 60 || v[1] < -60 || v[1] > this.h + 60) continue;
        const rr = 26 + 6 * Math.sin(t * 2 + n.id);
        for (let q = 0; q < 3; q++) { ctx.fillStyle = `rgba(${30 + q * 15},${35 + q * 15},${55 + q * 15},.55)`; ctx.beginPath(); ctx.ellipse(v[0] + Math.cos(t * 1.5 + q * 2.1 + n.id) * 8, v[1] - 22 + q * 4, rr - q * 6, (rr - q * 6) * 0.45, 0, 0, 7); ctx.fill(); }
        if (((t * 3 + n.id * 0.37) % 2.3) < 0.12) { ctx.strokeStyle = '#fff6b0'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(v[0], v[1] - 20); ctx.lineTo(v[0] - 6, v[1] - 8); ctx.lineTo(v[0] + 3, v[1] - 6); ctx.lineTo(v[0] - 4, v[1] + 6); ctx.stroke(); }
      }
      const c = this.map.id(Math.floor(cam.tx), Math.floor(cam.tz));
      if (c >= 0 && g.owner[c] === st.pref) {
        ctx.fillStyle = 'rgba(20,25,40,.35)'; ctx.fillRect(0, 0, this.w, this.h);
        ctx.strokeStyle = 'rgba(190,205,230,.5)'; ctx.lineWidth = 1.2; ctx.beginPath();
        for (let k = 0; k < 140; k++) { const sx = ((k * 97.3 + t * 420) % (this.w + 80)) - 40, sy = ((k * 53.7 + t * 900 + k * k) % (this.h + 40)) - 20; ctx.moveTo(sx, sy); ctx.lineTo(sx - 9, sy + 22); }
        ctx.stroke();
        if ((t % 3.1) < 0.08) { ctx.fillStyle = 'rgba(255,255,240,.5)'; ctx.fillRect(0, 0, this.w, this.h); }
      }
    }
    // 疫病：かかった兵の上に黒紫のもや
    if (g.plagueOn) {
      const a = g.lerpA ? g.lerpA() : 1;
      let n = 0;
      for (const u of g.units) {
        if (!u.sick || !u.alive || n > 400) continue;
        const x = u.px + (u.x - u.px) * a, z = u.py + (u.y - u.py) * a;
        if (!cam.project(x, this.unitH() * 1.2, z, v) || v[0] < -20 || v[0] > this.w + 20 || v[1] < -20 || v[1] > this.h + 20) continue;
        const r0 = Math.max(3, Math.min(14, (this.pxAt ? this.pxAt(x, 0.5, z) : 4) * 0.3));
        ctx.fillStyle = `rgba(90,30,110,${0.35 + 0.15 * Math.sin(t * 4 + u.id)})`; ctx.beginPath(); ctx.arc(v[0] + Math.sin(t * 2 + u.id) * 2, v[1] - Math.abs(Math.sin(t + u.id)) * 3, r0, 0, 7); ctx.fill();
        n++;
      }
    }
    // 天空城の耐久
    for (const f of g.skyForts || []) {
      if (!cam.project(f.x, this.skyAlt() + 4 * this.skyScale(), f.y, v) || v[0] < -40 || v[0] > this.w + 40 || v[1] < -40 || v[1] > this.h + 40) continue;
      const fr = Math.max(0, f.hp / f.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,.65)'; ctx.fillRect(v[0] - 41, v[1] - 4, 82, 8);
      ctx.fillStyle = this.map.prefs[f.P].color; ctx.fillRect(v[0] - 40, v[1] - 3, 80 * fr, 6);
      ctx.font = '700 11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,18,6,.9)';
      ctx.strokeText('天空城', v[0], v[1] - 6); ctx.fillStyle = '#ffe9a8'; ctx.fillText('天空城', v[0], v[1] - 6);
    }
    // 使った瞬間：大鐘の金の波紋・地割れの土煙・天空城の墜落
    if (this.superFx && this.superFx.length) {
      const keep = [];
      for (const f of this.superFx) {
        const age = t - f.t0;
        if (f.kind === 'bell' && age < 3) {
          keep.push(f);
          for (let q = 0; q < 3; q++) { const k = (age - q * 0.35) / 2.2; if (k <= 0 || k >= 1) continue; if (this.groundCircle(ctx, f.x, f.y, f.r * k)) { ctx.lineWidth = 4; ctx.strokeStyle = `rgba(255,220,100,${1 - k})`; ctx.stroke(); } }
          if (age < 0.5) { ctx.fillStyle = `rgba(255,230,140,${0.4 * (1 - age / 0.5)})`; ctx.fillRect(0, 0, this.w, this.h); }
        } else if (f.kind === 'rift' && age < 2.5) {
          keep.push(f);
          for (let k = 0; k < 12; k++) {
            const q = (k + 0.5) / 12, x = f.x + (f.x2 - f.x) * q, z = f.y + (f.y2 - f.y) * q;
            if (!cam.project(x, age * 2, z, v)) continue;
            ctx.fillStyle = `rgba(140,110,80,${0.5 * (1 - age / 2.5)})`; ctx.beginPath(); ctx.arc(v[0], v[1], 8 + age * 14, 0, 7); ctx.fill();
          }
        } else if (f.kind === 'skyfall' && age < 3) {
          keep.push(f);
          if (cam.project(f.x, 0, f.y, v)) { const k = age / 3; ctx.fillStyle = `rgba(255,${Math.round(180 - 120 * k)},60,${0.85 * (1 - k)})`; ctx.beginPath(); ctx.ellipse(v[0], v[1] - 10, 30 + 90 * k, (30 + 90 * k) * 0.6, 0, 0, 7); ctx.fill(); }
        } else if (f.kind === 'storm' && age < 1.2) {
          keep.push(f);
          ctx.fillStyle = `rgba(230,240,255,${0.5 * (1 - age / 1.2)})`; ctx.fillRect(0, 0, this.w, this.h);
        } else if (f.kind === 'plague' && age < 2) {
          keep.push(f);
          if (this.groundCircle(ctx, f.x, f.y, f.r * (0.3 + age * 0.5))) { ctx.fillStyle = `rgba(90,30,110,${0.35 * (1 - age / 2)})`; ctx.fill(); }
        }
      }
      this.superFx = keep;
    }
  },
  /** 天空城の高さと大きさ（三人称視点は兵の大きさに合わせる） */
  skyAlt() { return this.isTps() ? 9 : Math.max(6, this.unitH() * 8); },
  skyScale() { return this.isTps() ? 1.6 : Math.max(1.2, this.unitH() * 1.6); },
  drawNukeFx(ctx) {
    const g = this.game, cam = this.cam, v = [0, 0], w2 = [0, 0];
    if (!g) return;
    this.drawSuperState(ctx);
    // 狙っている場所
    const A = this.nukeAim;
    if (A && A.pts.length) {
      const pulse = 0.5 + 0.5 * Math.sin(this.clock * 5), [ax, az] = A.pts[0];
      const cross = (x, z) => { if (cam.project(x, 0, z, v)) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(v[0] - 14, v[1]); ctx.lineTo(v[0] + 14, v[1]); ctx.moveTo(v[0], v[1] - 14); ctx.lineTo(v[0], v[1] + 14); ctx.stroke(); } };
      ctx.save();
      if (A.kind === 'nuke' || A.kind === 'bell' || A.kind === 'plague') {
        const R = g.superR(A.kind), gold = A.kind === 'bell', pur = A.kind === 'plague';
        if (this.groundCircle(ctx, ax, az, R)) {
          ctx.fillStyle = gold ? `rgba(240,200,60,${0.2 + 0.08 * pulse})` : pur ? `rgba(120,40,140,${0.25 + 0.08 * pulse})` : `rgba(220,30,20,${0.22 + 0.08 * pulse})`; ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = gold ? '#ffe07a' : pur ? '#d08aff' : '#ff5a3a'; ctx.stroke();
        }
        cross(ax, az);
      } else if (A.kind === 'rift') {
        cross(ax, az);
        if (A.pts[1]) {
          let [bx, bz] = A.pts[1];
          const L = Math.hypot(bx - ax, bz - az), maxL = CONFIG.SUPER.rift.len * (this.map.scale || 1);
          if (L > maxL) { bx = ax + (bx - ax) / L * maxL; bz = az + (bz - az) / L * maxL; }
          const hw = CONFIG.SUPER.rift.hw * (this.map.scale || 1), nx = -(bz - az) / (L || 1) * hw, nz = (bx - ax) / (L || 1) * hw;
          const q = [[ax + nx, az + nz], [bx + nx, bz + nz], [bx - nx, bz - nz], [ax - nx, az - nz]].map(([x, z]) => cam.project(x, 0.05, z, [0, 0]));
          if (q.every(Boolean)) { ctx.beginPath(); q.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.fillStyle = `rgba(200,80,20,${0.3 + 0.1 * pulse})`; ctx.fill(); ctx.strokeStyle = '#ff9a4a'; ctx.lineWidth = 2; ctx.stroke(); }
          cross(bx, bz);
        }
      } else if (A.kind === 'storm') {
        const c = this.map.id(Math.floor(ax), Math.floor(az)), Q = c >= 0 ? g.owner[c] : 0;
        if (Q && Q <= 47) for (const n of g.nodes) if (n.owner === Q && cam.project(n.x, 0, n.y, v)) { ctx.fillStyle = `rgba(40,50,90,${0.35 + 0.1 * pulse})`; ctx.beginPath(); ctx.arc(v[0], v[1], 18, 0, 7); ctx.fill(); ctx.strokeStyle = '#9ab8ff'; ctx.lineWidth = 2; ctx.stroke(); }
        cross(ax, az);
      } else if (A.kind === 'sky') {
        const b = A.b, o = [0, 0];
        if (cam.project(b.x, 0, b.y, o) && cam.project(ax, 0, az, v)) { ctx.setLineDash([10, 6]); ctx.strokeStyle = '#ffe07a'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(o[0], o[1]); ctx.lineTo(v[0], v[1]); ctx.stroke(); ctx.setLineDash([]); }
        cross(ax, az);
      }
      ctx.restore();
    }
    if (!this.nukeFx || !this.nukeFx.length) return;
    const keep = [];
    for (const f of this.nukeFx) {
      const age = this.clock - f.t0;
      if (f.phase === 'launch') {
        const t = age / f.flight;
        if (t >= 1) continue;
        keep.push(f);
        const L = Math.hypot(f.x - f.ox, f.y - f.oy), H = Math.max(20, L * 0.35);
        const at = (q) => [f.ox + (f.x - f.ox) * q, H * 4 * q * (1 - q), f.oy + (f.y - f.oy) * q];
        // 煙の尾
        ctx.save(); ctx.lineCap = 'round';
        for (let k = 0; k < 24; k++) {
          const q0 = Math.max(0, t - (k + 1) * 0.02), q1 = Math.max(0, t - k * 0.02);
          const p0 = at(q0), p1 = at(q1);
          if (!cam.project(p0[0], p0[1], p0[2], v) || !cam.project(p1[0], p1[1], p1[2], w2)) continue;
          ctx.strokeStyle = `rgba(235,235,230,${0.55 * (1 - k / 24)})`; ctx.lineWidth = 6 - k * 0.18;
          ctx.beginPath(); ctx.moveTo(v[0], v[1]); ctx.lineTo(w2[0], w2[1]); ctx.stroke();
        }
        const hp = at(t);
        if (cam.project(hp[0], hp[1], hp[2], v)) {
          const gl2 = ctx.createRadialGradient(v[0], v[1], 0, v[0], v[1], 16);
          gl2.addColorStop(0, 'rgba(255,255,220,1)'); gl2.addColorStop(0.4, 'rgba(255,170,60,.8)'); gl2.addColorStop(1, 'rgba(255,80,20,0)');
          ctx.fillStyle = gl2; ctx.beginPath(); ctx.arc(v[0], v[1], 16, 0, 7); ctx.fill();
        }
        ctx.restore();
      } else {
        const T = 7;
        if (age >= T) continue;
        keep.push(f);
        const k = age / T;
        ctx.save();
        // 閃光（画面全体）
        if (age < 0.9) { ctx.fillStyle = `rgba(255,252,235,${0.85 * (1 - age / 0.9) ** 1.5})`; ctx.fillRect(0, 0, this.w, this.h); }
        // 衝撃波：地面を広がる白い輪
        const sk = Math.min(1, age / 2.2);
        if (sk < 1 && this.groundCircle(ctx, f.x, f.y, f.r * (0.15 + 0.95 * sk))) { ctx.lineWidth = 4; ctx.strokeStyle = `rgba(255,245,220,${0.9 * (1 - sk)})`; ctx.stroke(); }
        // 焼けた円
        if (this.groundCircle(ctx, f.x, f.y, f.r)) { ctx.fillStyle = `rgba(40,18,8,${0.35 * (1 - k)})`; ctx.fill(); }
        // 火の玉ときのこ雲
        if (cam.project(f.x, 0, f.y, v) && cam.project(f.x + f.r, 0, f.y, w2)) {
          const rs = Math.min(this.h * 0.6, Math.hypot(w2[0] - v[0], w2[1] - v[1]));
          const rise = Math.min(1, age / 3.5), top = [0, 0];
          if (cam.project(f.x, f.r * 1.4 * rise, f.y, top)) {
            ctx.fillStyle = `rgba(90,70,60,${0.75 * (1 - k)})`;   // 柱
            ctx.fillRect(top[0] - rs * 0.12, top[1], rs * 0.24, Math.max(0, v[1] - top[1]));
            for (let q = 0; q < 3; q++) {   // かさ
              const cr = rs * (0.3 + 0.35 * rise) * (1 - q * 0.22);
              ctx.fillStyle = q === 0 ? `rgba(110,80,60,${0.8 * (1 - k)})` : q === 1 ? `rgba(200,110,50,${0.7 * (1 - k)})` : `rgba(255,210,120,${0.75 * (1 - k)})`;
              ctx.beginPath(); ctx.ellipse(top[0], top[1] - q * cr * 0.15, cr * 1.35, cr * 0.75, 0, 0, 7); ctx.fill();
            }
          }
          const fb = rs * 0.55 * (0.4 + Math.min(1, age / 0.6) * 0.6) * (1 - k * 0.6);   // 火の玉
          const gr = ctx.createRadialGradient(v[0], v[1] - fb * 0.3, 0, v[0], v[1] - fb * 0.3, fb);
          gr.addColorStop(0, `rgba(255,255,230,${1 - k})`); gr.addColorStop(0.35, `rgba(255,170,60,${0.9 * (1 - k)})`); gr.addColorStop(1, 'rgba(160,40,10,0)');
          ctx.fillStyle = gr; ctx.beginPath(); ctx.arc(v[0], v[1] - fb * 0.3, fb, 0, 7); ctx.fill();
        }
        ctx.restore();
      }
    }
    this.nukeFx = keep;
  },

  /** 大将の体力・レベルと、今いる場所（自県／敵の領土） */
  genHud(gen) {
    this.updateNukeBtn();
    const g = this.game, bar = $('gh-bar'), where = $('gh-where');
    void bar;   // 大将には体力がない（建てるだけ）
    let txt = '', cls = '';
    if (!gen) txt = '県庁で立て直し中';
    else {
      const own = g.owner[g.cellAt(gen.x, gen.y)], P = this.map.prefs[own];
      if (own === WASTE) txt = '<i style="background:#4a4038"></i>焦土（持ち主なし）';
      else if (own === this.me) txt = `<i style="background:${P.color}"></i>自県の領土`;
      else if (P) { txt = `<i style="background:${P.color}"></i>${P.name}の領土（ここには建てられない）`; cls = 'enemy'; }
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

  /** 横に長い帯を、なぞって左右に動かす。少しでも動かしたら、その指を離したときのタップ（カードを選ぶ）は無効にする */
  dragScroll(el) {
    let id = null, last = null, moved = 0, vel = 0, lastT = 0, raf = 0;
    el.style.touchAction = 'none';
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      id = e.pointerId; last = this.toApp(e.clientX, e.clientY); moved = 0; vel = 0; lastT = performance.now();
      cancelAnimationFrame(raf);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const p = this.toApp(e.clientX, e.clientY), dx = p[0] - last[0];
      last = p; moved += Math.abs(dx);
      if (moved > 6) {
        if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
        el.scrollLeft -= dx;
        const now = performance.now(); vel = dx / Math.max(1, now - lastT); lastT = now;
      }
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (moved > 6) {
        // 指を離したあとも少し滑る
        let v = vel * 16;
        const glide = () => { if (Math.abs(v) < 0.5) return; el.scrollLeft -= v; v *= 0.92; raf = requestAnimationFrame(glide); };
        raf = requestAnimationFrame(glide);
      }
    };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    // なぞった後のタップは無視（カードを誤って選ばないように）
    el.addEventListener('click', (e) => { if (moved > 6) { e.stopPropagation(); e.preventDefault(); moved = 0; } }, true);
    // PC：ホイールで左右に
    el.addEventListener('wheel', (e) => { el.scrollLeft += (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY); e.preventDefault(); }, { passive: false });
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
    $('t-nuke').addEventListener('click', () => this.openWeapons());
    $('superpick').addEventListener('click', (e) => { const b = e.target.closest('[data-wk]'); if (b) this.startSuperAim(b.dataset.wk); });
    // 建物のカードと分類の帯は、指でなぞって左右に動かす（画面を回しているときもゲーム画面の向きで。ブラウザ任せだと回した画面では動かない）
    for (const el of [$('buildmenu'), $('bcats')]) this.dragScroll(el);
    $('nb-cancel').addEventListener('click', () => { this.cancelNuke(); this.setView('tps'); });
    $('nb-fire').addEventListener('click', () => this.fireNuke());
    for (const id of ['t-orient']) $(id).addEventListener('click', () => this.toggleOrient());
    // 下の帯の高さ（スティックと記録をその上に置く）
    const bb = $('bottombar'), setH = () => document.body.style.setProperty('--bbh', bb.offsetHeight + 'px');
    if (window.ResizeObserver) new ResizeObserver(setH).observe(bb); else window.addEventListener('resize', setH);
    setH();
    $('bc-place').addEventListener('click', () => this.placeBuild());
    $('t-build').addEventListener('click', () => this.toggleBuild());
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
