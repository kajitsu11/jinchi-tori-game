// =====================================================================
// アプリ本体（ステートマシン）
// =====================================================================
const STATE = { LOADING: 'LOADING', TITLE: 'TITLE', PLAYING: 'PLAYING', GAMEOVER: 'GAMEOVER' };

const App = {
  state: null,
  stateCtrl: null,     // ステートごとのイベントを片付ける AbortController
  map: null, renderer: null, cam: new Camera(), game: null,
  me: 0, titleSel: 0, topView: false, sel: -1, paused: false,
  lastT: 0, clock: 0, minimapT: 0, minimapDirty: true,
  dpr: 1, w: 1, h: 1,
  bannerTimer: 0,

  setState(s, arg) {
    if (this.stateCtrl) this.stateCtrl.abort();
    this.stateCtrl = new AbortController();
    const prev = this.state;
    this.state = s;
    document.body.dataset.state = s;
    const enter = this['enter' + s];
    if (enter) enter.call(this, this.stateCtrl.signal, arg, prev);
  },

  // ------------------------------------------------ LOADING
  async enterLOADING() {
    const bar = $('loadbar'), msg = $('loadmsg');
    const progress = (p, m) => { bar.style.width = (p * 100).toFixed(0) + '%'; if (m) msg.textContent = m; };
    try {
      progress(0.02, 'マップデータを読み込み中…');
      await nextFrame();
      const raw = JSON.parse($('mapdata').textContent);
      $('mapdata').remove();   // 大きな文字列はもう不要
      this.map = new MapData(raw);
      await this.map.decode(progress);
      progress(0.5, '3D描画を準備中…'); await nextFrame();
      this.renderer = new Renderer($('gl'), this.map);
      this.cam.bounds = [0, 0, this.map.W, this.map.H];
      this.renderer.setPalette(this.map.paletteColors());
      progress(0.65, '地形テクスチャを作成中…'); await nextFrame();
      this.renderer.uploadTerrain();
      progress(0.85, '領土テクスチャを作成中…'); await nextFrame();
      this.renderer.attachGame(null, 0);
      progress(1, '準備完了');
      this.setupInput();
      this.resize();
      this.resetCamera(true);
      this.buildTitleList();
      await nextFrame();
      $('loading').classList.add('hidden');
      this.setState(STATE.TITLE);
    } catch (e) {
      console.error(e);
      msg.textContent = 'エラー: ' + e.message;
      bar.style.background = '#ff4a3d';
      window.__jinchiError = e.message;
    }
  },

  // ------------------------------------------------ TITLE
  enterTITLE(signal) {
    if (this.game) { this.game.dispose(); this.game = null; }
    this.fx = [];
    this.renderer.attachGame(null, 0);
    this.topView = false; this.cam.pitchGoal = CONFIG.TITLE_PITCH;
    this.sel = -1; this.paused = false;
    this.closeModal();
    $('title').classList.remove('hidden');
    $('hud').classList.add('hidden');
    $('t-cells').textContent = Math.round(this.map.landCells / 10000) + '万';
    this.resetCamera(false);
    $('pref-list').addEventListener('click', (e) => {
      const b = e.target.closest('.pbtn');
      if (b) this.selectTitlePref(+b.dataset.p, true);
    }, { signal });
    $('btn-start').addEventListener('click', () => {
      if (this.titleSel) this.startGame(this.titleSel);
    }, { signal });
    signal.addEventListener('abort', () => $('title').classList.add('hidden'));
    if (this.titleSel) this.selectTitlePref(this.titleSel, false);
  },
  buildTitleList() {
    const regions = {};
    for (const p of this.map.prefs) if (p) (regions[p.area] || (regions[p.area] = [])).push(p);
    let html = '';
    for (const [area, list] of Object.entries(regions)) {
      html += `<div class="region"><h3>${area}</h3><div class="prefs">`;
      for (const p of list) html += `<button class="pbtn" data-p="${p.id}"><span class="chip" style="background:${p.color}"></span>${escapeHtml(p.short)}</button>`;
      html += '</div></div>';
    }
    $('pref-list').innerHTML = html;
  },
  selectTitlePref(p, fly) {
    this.titleSel = p;
    const pr = this.map.prefs[p];
    for (const b of document.querySelectorAll('.pbtn')) b.classList.toggle('sel', +b.dataset.p === p);
    $('pd-chip').style.background = pr.color;
    $('pd-name').textContent = pr.name;
    const n = Math.max(CONFIG.MIN_PARTICIPANTS, Math.round(pr.pop / 100 * CONFIG.PARTICIPANTS_PER_MILLION));
    $('pd-sub').textContent = `人口${fmt(Math.round(pr.pop))}万人・参加者${n}人（あなた＋AI${n - 1}人）・${fmt(this.map.initCounts[p])}マス`;
    $('btn-start').disabled = false;
    const b = document.querySelector(`.pbtn[data-p="${p}"]`);
    if (b && fly) b.scrollIntoView({ block: 'nearest' });
    if (fly) this.flyToPref(p, 700, 0.3);
  },
  flyToPref(p, dist, anchorY) {
    const c = this.map.capitalCell[p];
    this.cam.flyTo((c % this.map.W) + 0.5, ((c / this.map.W) | 0) + 0.5, dist, anchorY);
  },
  resetCamera(instant) {
    const W = this.map.W, H = this.map.H;
    const aspect = this.w / this.h;
    const th = Math.tan(this.cam.fovY / 2);
    // タイトルでは下のシートに隠れないよう、画面上側に日本全体を出す
    const title = this.state === STATE.TITLE || this.state === STATE.LOADING || !this.state;
    // タイトル：見出しと下のシートの間（画面の約12%〜48%）に沖縄まで含めた日本全体を収める
    const band = title ? 0.36 : 0.62;
    const dist = clamp(Math.max(W * (title ? 1.0 : 0.85) / (2 * th * aspect), H / (band * 2 * th)), 500, CONFIG.ZOOM_MAX);
    this.cam.flyTo(W * 0.5, H * 0.5, dist, title ? 0.29 : 0.5);
    if (instant) { const g = this.cam.goal; this.cam.tx = g.x; this.cam.tz = g.z; this.cam.dist = g.dist; this.cam.goal = null; }
  },

  // ------------------------------------------------ PLAYING
  startGame(p) {
    this.me = p;
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam ? +seedParam : (Date.now() & 0x7fffffff);
    this.game = new Sim(this.map, p, seed);
    this.renderer.attachGame(this.game, p);
    this.setState(STATE.PLAYING);
  },

  // ------------------------------------------------ GAMEOVER

  // ------------------------------------------------ HUD / パネル
  enterPLAYING(signal) {
    const g = this.game, map = this.map;
    $('hud').classList.remove('hidden');
    $('log').innerHTML = '';
    this.sel = -1; this.paused = false; this.topView = false; this.marker = null; this.hudT = 0;
    this.cam.pitchGoal = CONFIG.CAMERA_PITCH;
    $('btn-top').classList.remove('on'); $('toplabel').classList.add('hidden');
    this.hidePanel();
    const pr = map.prefs[this.me];
    $('h-chip').style.background = pr.color;
    $('h-pref').textContent = pr.name;
    this.goUnit(140);
    // シミュレーションのイベント
    g.on('cells', (cells) => { for (const i of cells) this.renderer.cellChanged(i); this.minimapDirty = true; });
    g.on('capture', (e) => this.onCapture(e));
    g.on('death', (u) => { if (u.player) this.log(`💀 あなたの部隊がやられました。${CONFIG.RESPAWN}秒後に近くの拠点で復活します`, 'bad', -1); });
    g.on('respawn', (u) => { if (u.player) this.log('🪖 部隊が復活しました', 'good', -1); });
    g.on('fort', (e) => {
      if (e.by !== this.me) return;
      if (e.byPlayer) { this.banner('砦を建設！', 'def', `国境が広がりました（+${fmt(e.cells)}マス）`); this.log(`🏰 砦を建てました（+${fmt(e.cells)}マス）`, 'good', e.node.cell); }
      else this.log(`🏰 味方が${e.node.name}を建てました`, 'good', e.node.cell);
    });
    g.on('eliminated', (p) => { if (p !== this.me) this.log(`${map.prefs[p].name}が全ての拠点を失い、脱落しました`, 'bad', -1); });
    g.on('over', () => setTimeout(() => { if (this.state === STATE.PLAYING) this.setState(STATE.GAMEOVER); }, 900));
    // UI イベント
    $('btn-unit').addEventListener('click', () => this.goUnit(), { signal });
    $('btn-fort').addEventListener('click', () => this.onFort(), { signal });
    $('btn-auto').addEventListener('click', () => { g.auto = !g.auto; if (!g.auto) { g.player.dest = null; g.player.path = null; g.player.chase = -1; } this.updateHud(true); }, { signal });
    $('cp-close').addEventListener('click', () => this.hidePanel(), { signal });
    $('sidebtns').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'rank') this.showRanking();
      else if (act === 'top') this.toggleTop();
      else if (act === 'home') this.goHome();
      else if (act === 'title') this.confirmTitle();
    }, { signal });
    $('log').addEventListener('click', (e) => {
      const d = e.target.closest('[data-cell]');
      if (d && +d.dataset.cell >= 0) this.focusCell(+d.dataset.cell);
    }, { signal });
    $('minimap').addEventListener('pointerdown', (e) => this.onMinimap(e), { signal });
    signal.addEventListener('abort', () => { this.hidePanel(); });
    this.updateHud(true);
    this.log(`出陣！ ${pr.name}の参加者${g.participantCount(this.me)}人（あなた＋AI）。地図をタップして部隊を動かそう`, 'good', -1);
  },
  onCapture(e) {
    const map = this.map, me = this.me, n = e.node, u = this.game.player;
    const near = u.alive && Math.hypot(u.x - n.x, u.y - n.y) <= CONFIG.CAPTURE_RADIUS + 1;
    if (e.from === me) {
      this.log(`⚠ ${n.name}を${map.prefs[e.by].name}に奪われました（−${fmt(e.cells)}マス）`, 'bad', n.cell);
      if (n.type === 'capital') this.banner('県庁を奪われた！', 'ng', `${map.prefs[e.by].name}に占領されました`);
    } else if (e.by === me) {
      this.log(`🚩 ${n.name}を占領しました（+${fmt(e.cells)}マス）`, 'good', n.cell);
      if (near || n.type === 'capital') this.banner(n.type === 'capital' ? `${map.prefs[n.pref].short}県庁を占領！` : '占領成功！', 'ok', `${n.name}（+${fmt(e.cells)}マス）`);
    }
    if (this.sel === n.id) this.updatePanel();
  },
  onFort() {
    const g = this.game;
    if (!g || this.paused) return;
    const r = g.commandFort();
    if (!r.ok) {
      const msg = { dead: '部隊が倒れています', sea: '海の上には建てられません', notown: '自県の領土の中で建ててください', near: `ほかの拠点から${CONFIG.FORT_MIN_DIST}マス以上離してください`, gold: '軍資金が足りません' }[r.why] || '建てられません';
      this.banner('建設できません', 'ng', msg);
    }
    this.updateHud(true);
  },
  goUnit(dist) {
    const u = this.game && this.game.player;
    if (!u) return;
    this.cam.flyTo(u.x, u.y, dist || Math.min(this.cam.dist, 200), 0.45);
  },
  goHome() {
    const g = this.game, cap = g.nodes[this.me - 1];
    let n = cap.owner === this.me ? cap : g.nodes.find((q) => q.owner === this.me);
    if (n) this.cam.flyTo(n.x, n.y, 300, 0.45);
  },
  toggleTop() {
    this.topView = !this.topView;
    this.cam.pitchGoal = this.topView ? CONFIG.TOP_PITCH : CONFIG.CAMERA_PITCH;
    $('btn-top').classList.toggle('on', this.topView);
    $('toplabel').classList.toggle('hidden', !this.topView);
  },
  confirmTitle() {
    this.openModal('タイトルに戻りますか？', '<p style="text-align:center">今のゲームの進行は失われます。</p>', [
      { label: 'やめる', fn: () => this.closeModal() },
      { label: 'タイトルへ', cls: 'warn', fn: () => { this.closeModal(); this.setState(STATE.TITLE); } },
    ]);
  },
  fmtTime(t) { const s = Math.floor(t); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; },

  // ------------------------------------------------ GAMEOVER
  enterGAMEOVER(signal) {
    const g = this.game, map = this.map, o = g.over;
    this.hidePanel();
    let head, cls, detail;
    if (o.win) { head = '天下統一！'; cls = 'win'; detail = `${map.prefs[this.me].name}が全国の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else if (o.reason === 'rival') { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[o.rival].name}が全国の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[this.me].name}は全ての拠点を失いました。`; }
    const body = `<div class="result-big ${cls}">${head}</div><p style="text-align:center">${detail}<br>経過 ${this.fmtTime(o.time)}・最終領土 ${fmt(g.counts[this.me])}マス・${g.rankOf(this.me)}位<br>あなたの部隊の撃破数 ${g.player.kills}</p>`;
    this.openModal('ゲーム終了', body, [{ label: 'タイトルへ', cls: 'primary', fn: () => this.setState(STATE.TITLE) }]);
    signal.addEventListener('abort', () => { this.closeModal(); $('hud').classList.add('hidden'); });
  },

  // ------------------------------------------------ HUD / パネル
  updateHud(force) {
    const g = this.game;
    if (!g) return;
    if (!force && this.clock - (this.hudT || 0) < CONFIG.HUD_REFRESH) return;
    this.hudT = this.clock;
    const me = this.me, u = g.player;
    $('h-time').textContent = '⏱ ' + this.fmtTime(g.time);
    const c = g.counts[me], d = c - this.map.initCounts[me];
    $('h-cells').textContent = fmt(c);
    const dEl = $('h-delta');
    dEl.textContent = `(${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))})`;
    dEl.className = d > 0 ? 'up' : d < 0 ? 'down' : '';
    $('h-rank').textContent = g.rankOf(me) + '位';
    $('h-gold').textContent = fmt(Math.floor(g.gold[me]));
    $('h-income').textContent = `(+${g.income(me).toFixed(1)}/秒)`;
    $('h-today').textContent = `拠点 ${g.nodeCount[me]}・部隊 ${g.aliveUnits(me)}/${g.participantCount(me)}・全国の占領 ${fmt(g.stats.captures)}回`;
    // 自分の部隊
    let st;
    if (!u.alive) st = `💀 やられた — 復活まで ${Math.max(0, Math.ceil(u.respawnAt - g.time))}秒`;
    else if (u.engaged >= 0) st = `⚔ 戦闘中（${this.map.prefs[g.units[u.engaged].pref].short}の部隊と）`;
    else {
      const n = g.nodes.find((q) => q.capBy === me && Math.hypot(q.x - u.x, q.y - u.y) <= CONFIG.CAPTURE_RADIUS);
      if (n) st = `🚩 ${n.name}を占領中 ${Math.floor(n.progress / g.needFor(n) * 100)}%`;
      else if (u.dest) st = g.auto ? '🤖 おまかせで移動中' : '🚶 移動中';
      else if (g.auto) st = '🤖 おまかせ中';
      else st = '待機中 — 地図をタップすると部隊が向かいます';
    }
    $('u-status').textContent = st;
    $('u-hp').style.width = (u.hp / CONFIG.UNIT_HP * 100).toFixed(0) + '%';
    const why = u.alive ? g.canBuildFort(me, g.cellAt(u.x, u.y)) : 'dead';
    const fb = $('btn-fort');
    fb.disabled = !!why;
    fb.querySelector('small').textContent = why ? ({ dead: '部隊が倒れています', sea: '海の上', notown: '自県の領土で', near: '拠点に近すぎ', gold: '資金不足' }[why] || '') : `${fmt(CONFIG.FORT_COST)}億`;
    $('btn-auto').textContent = g.auto ? '🤖 おまかせ ON' : '🤖 おまかせ OFF';
    $('btn-auto').classList.toggle('on', g.auto);
    if (this.sel >= 0) this.updatePanel();
  },
  /** 拠点の情報パネル */
  selectNode(id) {
    this.sel = id;
    $('cellpanel').classList.remove('hidden');
    this.updatePanel();
  },
  hidePanel() { this.sel = -1; $('cellpanel').classList.add('hidden'); },
  updatePanel() {
    const g = this.game, map = this.map, n = g && g.nodes[this.sel];
    if (!n) return;
    $('cp-name').textContent = n.name;
    $('cp-chip').style.background = map.prefs[n.owner].color;
    $('cp-owner').textContent = `持ち主：${map.prefs[n.owner].name}${n.owner === this.me ? '（自県）' : ''}・${NODE_TYPE_NAME[n.type]}`;
    $('cp-meta').textContent = `領土 ${fmt(g.cellsOf(n.id).length)}マス・守備 ${n.defenders}部隊・攻撃 ${n.attackers}部隊${n.pref !== n.owner ? `・元は${map.prefs[n.pref].name}` : ''}`;
    const need = g.needFor(n);
    let note = '';
    if (n.capBy) note = `🚩 ${map.prefs[n.capBy].name}が占領中 ${Math.floor(n.progress / need * 100)}%`;
    else if (n.attackers && n.defenders) note = '⚔ 交戦中（守備側がいる間は占領が進みません）';
    else if (n.owner !== this.me) note = `部隊で近づくと占領できます（必要ポイント ${need}）`;
    $('cp-note').textContent = note;
  },
  focusCell(i) {
    this.cam.flyTo((i % this.map.W) + 0.5, ((i / this.map.W) | 0) + 0.5, Math.min(this.cam.dist, 120), 0.4);
  },
  showRanking() {
    const g = this.game, map = this.map;
    const rows = g.ranking().map((p, k) => {
      const c = g.counts[p], d = c - map.initCounts[p];
      const cls = (p === this.me ? ' me' : '') + (g.nodeCount[p] === 0 ? ' dead' : '');
      return `<div class="rank-row${cls}"><span class="no">${k + 1}</span><span class="chip" style="background:${map.prefs[p].color}"></span>` +
        `<span class="nm">${map.prefs[p].name}${g.nodeCount[p] === 0 ? '（脱落）' : ''}<small class="sub">拠点${g.nodeCount[p]}・部隊${g.aliveUnits(p)}</small></span>` +
        `<span class="ct">${fmt(c)}<small class="${d >= 0 ? 'plus' : 'minus'}"> ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}</small></span>` +
        `<span class="pc">${(c / map.landCells * 100).toFixed(2)}%</span></div>`;
    }).join('');
    this.openModal(`戦況（${this.fmtTime(g.time)}）`, rows, [{ label: '閉じる', fn: () => this.closeModal() }]);
  },

  // ------------------------------------------------ 建物・部隊の3D（インスタンス）
  buildBoxes() {
    const g = this.game, map = this.map, cam = this.cam;
    const need = (g ? g.units.length * 2 + g.nodes.length * 3 : 47 * 3) + 16;
    if (!this.boxData || this.boxData.length < need * 9) this.boxData = new Float32Array(need * 9 * 1.5 | 0);
    const d = this.boxData;
    let k = 0;
    const put = (x, y, z, sx, sy, sz, c) => {
      const o = k * 9;
      d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = sx; d[o + 4] = sy; d[o + 5] = sz; d[o + 6] = c[0]; d[o + 7] = c[1]; d[o + 8] = c[2];
      k++;
    };
    const v = [0, 0], m = 80;
    const visible = (x, z) => cam.project(x, 0, z, v) && v[0] > -m && v[0] < this.w + m && v[1] > -m && v[1] < this.h + m;
    if (!this.colCache) this.colCache = map.prefs.map((p) => (p ? hexToRgb(p.color).map((q) => q / 255) : [0, 0, 0]));
    const col = this.colCache;
    const sN = clamp(cam.dist * 0.0065, 0.9, 32), WHITE = [0.92, 0.92, 0.9], DARK = [0.25, 0.25, 0.3], STONE = [0.55, 0.56, 0.58];
    const nodes = g ? g.nodes : map.prefs.filter(Boolean).map((p) => ({ x: (p.capital % map.W) + 0.5, y: ((p.capital / map.W) | 0) + 0.5, owner: p.id, type: 'capital' }));
    const cpx = cam.cellPx();
    for (const n of nodes) {
      if (!visible(n.x, n.y)) continue;
      const c = col[n.owner];
      if (n.type === 'capital') {
        put(n.x, 0, n.y, sN * 1.6, sN * 0.5, sN * 1.2, WHITE);
        put(n.x, sN * 0.5, n.y, sN * 0.7, sN * 1.5, sN * 0.7, c);
        put(n.x, sN * 2.0, n.y, sN * 0.95, sN * 0.18, sN * 0.95, DARK);
      } else if (cpx > 0.12) {
        const s = sN * 0.62;
        if (n.type === 'town') {
          put(n.x, 0, n.y, s * 1.1, s * 0.6, s * 1.1, c);
          put(n.x, s * 0.6, n.y, s * 1.25, s * 0.22, s * 1.25, DARK);
        } else {
          put(n.x, 0, n.y, s * 1.3, s * 0.4, s * 1.3, STONE);
          put(n.x, s * 0.4, n.y, s * 0.12, s * 1.3, s * 0.12, WHITE);
          put(n.x + s * 0.3, s * 1.35, n.y, s * 0.55, s * 0.32, s * 0.06, c);
        }
      }
    }
    if (g) {
      const sU = clamp(cam.dist * 0.008, 1.4, 26), a = clamp(g.acc / CONFIG.TICK, 0, 1);
      const SKIN = [0.95, 0.82, 0.68], GOLD = [1, 0.82, 0.2];
      for (const u of g.units) {
        if (!u.alive) continue;
        const x = u.px + (u.x - u.px) * a, z = u.py + (u.y - u.py) * a;
        if (!visible(x, z)) continue;
        const s = u.player ? sU * 1.7 : sU;
        put(x, 0, z, s * 0.55, s * 1.0, s * 0.55, col[u.pref]);
        put(x, s * 1.0, z, s * 0.4, s * 0.4, s * 0.4, u.player ? GOLD : SKIN);
      }
    }
    return { data: d, count: k };
  },

  // ------------------------------------------------ ラベル・演出（2Dオーバーレイ）
  drawOverlay() {
    const cv = $('overlay'), ctx = cv.getContext('2d'), map = this.map, cam = this.cam, g = this.game;
    const dpr = this.dpr;
    if (cv.width !== Math.round(this.w * dpr) || cv.height !== Math.round(this.h * dpr)) { cv.width = Math.round(this.w * dpr); cv.height = Math.round(this.h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const cpx = cam.cellPx();
    const v = [0, 0], w = [0, 0];
    const onScreen = () => v[0] > -40 && v[0] < this.w + 40 && v[1] > -40 && v[1] < this.h + 40;
    ctx.lineJoin = 'round';
    const a = g ? clamp(g.acc / CONFIG.TICK, 0, 1) : 0;
    const upos = (u) => [u.px + (u.x - u.px) * a, u.py + (u.y - u.py) * a];
    // 交戦の線
    if (g && cpx > 0.6) {
      ctx.strokeStyle = 'rgba(255,230,120,.75)'; ctx.lineWidth = 1.2;
      ctx.beginPath();
      let n = 0;
      for (const u of g.units) {
        if (!u.alive || u.engaged < 0 || n > 500) continue;
        const [x, z] = upos(u), e = g.units[u.engaged], [ex, ez] = upos(e);
        if (!cam.project(x, 0.6, z, v) || !onScreen() || !cam.project(ex, 0.6, ez, w)) continue;
        ctx.moveTo(v[0], v[1]); ctx.lineTo(w[0], w[1]); n++;
      }
      ctx.stroke();
    }
    // HP バー（拡大時）
    if (g && cpx > 2.2) {
      for (const u of g.units) {
        if (!u.alive || u.hp >= CONFIG.UNIT_HP) continue;
        const [x, z] = upos(u);
        if (!cam.project(x, clamp(cam.dist * 0.008, 1.4, 26) * 1.6, z, v) || !onScreen()) continue;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(v[0] - 8, v[1] - 6, 16, 3);
        ctx.fillStyle = u.hp > 50 ? '#4ddc7a' : u.hp > 25 ? '#ffcf3f' : '#ff4a3d';
        ctx.fillRect(v[0] - 8, v[1] - 6, 16 * u.hp / CONFIG.UNIT_HP, 3);
      }
    }
    // 拠点の名前と占領ゲージ
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const fs = clamp(9 + Math.log2(cpx + 1) * 3, 9, 16);
    const bh = clamp(cam.dist * 0.0065, 0.9, 32) * 2.3;
    const placed = [];
    const nodes = g ? g.nodes : null;
    const order = [];
    if (nodes) {
      for (const n of nodes) if (n.type === 'capital' || cpx > 1.3 || n.progress > 0) order.push(n);
    } else {
      for (let p = 1; p <= 47; p++) order.push({ type: 'capital', pref: p, owner: p, x: (map.capitalCell[p] % map.W) + 0.5, y: ((map.capitalCell[p] / map.W) | 0) + 0.5 });
    }
    const pri = this.state === STATE.TITLE ? this.titleSel : this.me;
    const score = (n) => (n.pref === pri && n.type === 'capital' ? 1e6 : 0) + (n.type === 'capital' ? 1e4 + map.prefs[n.pref].pop : n.type === 'fort' ? 10 : 0);
    order.sort((p, q) => score(q) - score(p));
    for (const n of order) {
      if (!cam.project(n.x, n.type === 'capital' ? bh : bh * 0.4, n.y, v) || !onScreen()) continue;
      // 占領ゲージ
      if (g && n.progress > 0) {
        const r = 11, f = n.progress / g.needFor(n);
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.beginPath(); ctx.arc(v[0], v[1] - r - 2, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = map.prefs[n.capBy].color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(v[0], v[1] - r - 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f); ctx.stroke();
      } else if (g && n.attackers && n.defenders && cpx > 0.3) {
        ctx.font = `700 ${fs}px sans-serif`; ctx.fillStyle = '#ffe27a'; ctx.fillText('⚔', v[0], v[1] - 4);
      }
      const isCap = n.type === 'capital';
      const label = isCap ? map.prefs[n.pref].short + (cpx > 2 ? `（${map.prefs[n.pref].capName}）` : '') : n.name;
      const size = isCap ? fs : clamp(fs - 3, 9, 12);
      ctx.font = `${isCap ? 700 : 600} ${size}px sans-serif`;
      const tw = ctx.measureText(label).width;
      const ly = v[1] - (g && n.progress > 0 ? 26 : 2);
      const rect = [v[0] - tw / 2 - 2, ly - size - 2, v[0] + tw / 2 + 2, ly];
      if (placed.some((q) => q[0] < rect[2] && rect[0] < q[2] && q[1] < rect[3] && rect[1] < q[3])) continue;
      placed.push(rect);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)';
      ctx.strokeText(label, v[0], ly);
      ctx.fillStyle = n.owner === n.pref ? '#fff' : '#ffb3a8';
      ctx.fillText(label, v[0], ly);
      if (this.state === STATE.TITLE && isCap && n.pref === this.titleSel) { ctx.fillStyle = '#ffcf3f'; ctx.fillText('▼', v[0], ly - size - 2); }
    }
    // 連絡マスの名前・インセット
    ctx.textBaseline = 'bottom';
    if (cpx > 0.9) {
      ctx.font = `600 ${clamp(fs - 2, 9, 13)}px sans-serif`;
      const seen = new Set();
      for (const l of map.raw.links) {
        if (seen.has(l.name) || l.stub) continue;
        seen.add(l.name);
        const ax = l.a % map.W, ay = (l.a / map.W) | 0, bx = l.b % map.W, by = (l.b / map.W) | 0;
        if (!cam.project((ax + bx) / 2 + 0.5, 0, (ay + by) / 2 + 0.5, v)) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(l.name, v[0], v[1] - 4);
        ctx.fillStyle = '#ffe27a'; ctx.fillText(l.name, v[0], v[1] - 4);
      }
    }
    ctx.font = '600 11px sans-serif';
    for (const s of this.renderer.linkStubs) {
      if (!cam.project(s.x, 0, s.y, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(s.name, v[0], v[1] - 3);
      ctx.fillStyle = '#ffe27a'; ctx.fillText(s.name, v[0], v[1] - 3);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const r of map.raw.insets) {
      if (!cam.project(r.poly[2] + 4, 0, r.poly[3] + 4, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.strokeText(r.label, v[0], v[1]);
      ctx.fillStyle = '#fff'; ctx.fillText(r.label, v[0], v[1]);
    }
    if (!g || this.state !== STATE.PLAYING) return;
    // 自分の部隊：行き先までの線、旗、目印
    const u = g.player;
    if (u.alive && u.dest) {
      const [x, z] = upos(u);
      ctx.setLineDash([6, 5]); ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      const pts = [[x, z]];
      if (u.path) for (let k = u.pi; k < u.path.length; k++) pts.push(u.path[k]);
      pts.push(u.dest);
      for (const [px, pz] of pts) { if (!cam.project(px, 0.3, pz, v)) continue; started ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]); started = true; }
      ctx.stroke(); ctx.setLineDash([]);
      if (cam.project(u.dest[0], 0, u.dest[1], v)) { ctx.font = '18px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom'; ctx.fillText('🚩', v[0] - 3, v[1]); }
    }
    if (this.marker && this.clock - this.marker.t < 0.8) {
      const k = (this.clock - this.marker.t) / 0.8;
      if (cam.project(this.marker.x, 0, this.marker.z, v)) {
        ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(v[0], v[1], 6 + 18 * k, 0, Math.PI * 2); ctx.stroke();
      }
    }
    {
      const [x, z] = upos(u);
      const sU = clamp(cam.dist * 0.008, 1.4, 26) * 1.7;
      if (cam.project(x, sU * 1.6, z, v)) {
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.font = '800 12px sans-serif';
        const t = u.alive ? '▼あなた' : '💀';
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.strokeText(t, v[0], v[1] - 4);
        ctx.fillStyle = '#ffcf3f'; ctx.fillText(t, v[0], v[1] - 4);
      }
    }
  },
  onTap(sx, sy) {
    const i = this.pickCell(sx, sy);
    if (this.state === STATE.TITLE) {
      if (i >= 0 && this.map.isLand(i)) this.selectTitlePref(this.map.initPref[i], true);
      return;
    }
    if (this.state !== STATE.PLAYING || this.paused || i < 0) return;
    const g = this.game, p = this.cam.groundAt(sx, sy);
    // 近くの拠点をタップしたら情報を出す
    let near = -1, bd = Math.max(3, 14 / this.cam.cellPx());
    for (const n of g.nodes) { const d = Math.hypot(n.x - p.x, n.y - p.z); if (d < bd) { bd = d; near = n.id; } }
    if (near >= 0) this.selectNode(near); else this.hidePanel();
    if (!this.map.isLand(i)) { this.banner('海には行けません', 'ng', '陸地か、連絡マスの先をタップしてください'); return; }
    if (g.auto) { g.auto = false; }
    if (g.commandMove(p.x, p.z)) this.marker = { x: p.x, z: p.z, t: this.clock };
    else this.banner('部隊が倒れています', 'ng', '復活するまで待ってください');
    this.updateHud(true);
  },
  frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    this.clock += dt;
    if (this.renderer && !this.glLost) {
      this.keyPan(dt);
      this.cam.update(dt);
      if (this.state === STATE.PLAYING && this.game && !this.paused) {
        this.game.update(dt);
        this.updateHud(false);
      }
      const mixT = clamp((this.cam.pitch - CONFIG.CAMERA_PITCH) / (CONFIG.TOP_PITCH - CONFIG.CAMERA_PITCH), 0, 1);
      this.renderer.render(this.cam, {
        mix: CONFIG.OWNER_MIX + (CONFIG.OWNER_MIX_TOP - CONFIG.OWNER_MIX) * mixT,
        blink: 0, sel: -1, top: this.cam.pitch > 80, boxes: this.buildBoxes(),
      });
      this.drawOverlay();
      if (this.state === STATE.PLAYING || this.state === STATE.GAMEOVER) {
        this.minimapT -= dt;
        if (this.minimapT <= 0) { this.minimapT = CONFIG.MINIMAP_REFRESH; this.drawMinimap(); }
        else this.drawMinimapFrame();
      }
    }
    requestAnimationFrame((t) => this.frame(t));
  },
  log(text, cls, cell) {
    const box = $('log');
    // 同じ内容が続いたら「×n」でまとめる
    const first = box.firstElementChild;
    if (first && first.dataset.text === text) {
      const n = (+first.dataset.n || 1) + 1;
      first.dataset.n = n;
      first.dataset.cell = cell;
      first.textContent = `${this.game ? this.fmtTime(this.game.time) : ""} ${text} ×${n}`;
      return;
    }
    const el = document.createElement('div');
    el.dataset.text = text;
    el.className = cls || '';
    el.dataset.cell = cell;
    el.textContent = `${this.game ? this.fmtTime(this.game.time) : ""} ${text}`;
    box.prepend(el);
    // 古いログは片付ける
    while (box.children.length > CONFIG.LOG_MAX) box.lastElementChild.remove();
    Array.from(box.children).forEach((c, k) => c.classList.toggle('fade', k >= 2));
  },
  banner(text, cls, sub) {
    const b = $('banner');
    b.className = '';
    void b.offsetWidth;   // アニメーションを再始動
    b.innerHTML = escapeHtml(text) + (sub ? `<small>${escapeHtml(sub)}</small>` : '');
    b.className = 'show ' + cls;
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.className = ''; b.innerHTML = ''; }, CONFIG.BANNER_MS + 100);
  },

  // ------------------------------------------------ モーダル
  openModal(title, body, buttons, escFn) {
    this.paused = true;
    this.modalEsc = escFn || buttons[0].fn;
    $('m-title').textContent = title;
    $('m-body').innerHTML = body;
    const box = $('m-btns');
    box.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.cls) el.className = b.cls;
      el.onclick = b.fn;
      box.appendChild(el);
    }
    $('modal').classList.remove('hidden');
  },
  closeModal() {
    $('modal').classList.add('hidden');
    this.modalEsc = null;
    $('m-btns').innerHTML = '';   // ボタンのハンドラも破棄
    $('m-body').innerHTML = '';
    this.paused = false;
  },

  // ------------------------------------------------ ミニマップ
  drawMinimap() {
    const cv = $('minimap'), map = this.map, g = this.game;
    const mw = 236, mh = Math.round(mw * map.H / map.W);
    if (cv.width !== mw) { cv.width = mw; cv.height = mh; this.mmImage = null; }
    const ctx = cv.getContext('2d');
    if (this.minimapDirty || !this.mmImage) {
      const img = this.mmImage || ctx.createImageData(mw, mh);
      const d = img.data, own = g ? g.owner : map.initPref;
      const cols = map.prefs.map((p) => (p ? hexToRgb(p.color) : [20, 42, 70]));
      const sx = map.W / mw, sy = map.H / mh;
      for (let y = 0; y < mh; y++) {
        for (let x = 0; x < mw; x++) {
          // 3x3 点サンプリングで小さな島も拾う
          let o = 0;
          for (let k = 0; k < 9 && !o; k++) {
            const cx = Math.floor((x + (k % 3) / 3 + 0.17) * sx), cy = Math.floor((y + ((k / 3) | 0) / 3 + 0.17) * sy);
            o = own[cy * map.W + cx];
          }
          const c = cols[o] || cols[0], q = (y * mw + x) * 4;
          d[q] = c[0]; d[q + 1] = c[1]; d[q + 2] = c[2]; d[q + 3] = 255;
        }
      }
      this.mmImage = img;
      this.minimapDirty = false;
    }
    ctx.putImageData(this.mmImage, 0, 0);
    // 表示範囲の枠
    const pts = [[0, 0], [this.w, 0], [this.w, this.h], [0, this.h]].map(([x, y]) => this.cam.groundAt(x, y));
    if (pts.every(Boolean)) {
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath();
      pts.forEach((p, k) => { const X = p.x / map.W * mw, Y = p.z / map.H * mh; k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
    }
    const u = g && g.player;
    if (u && u.alive) {
      ctx.fillStyle = '#ffcf3f'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(u.x / map.W * mw, u.y / map.H * mh, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  },
  onMinimap(e) {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * this.map.W, z = (e.clientY - r.top) / r.height * this.map.H;
    this.cam.flyTo(x, z, null);
    e.preventDefault();
  },

  // ------------------------------------------------ ラベル（2Dオーバーレイ）

  /** ミサイル・爆発・迎撃の演出（2Dオーバーレイ） */

  // ------------------------------------------------ 入力
  setupInput() {
    const cv = $('gl');
    const ptrs = new Map();
    let tap = null, pinch = null;
    const pos = (e) => [e.clientX, e.clientY];
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      ptrs.set(e.pointerId, pos(e));
      if (ptrs.size === 1) tap = { x: e.clientX, y: e.clientY, t: performance.now(), moved: false };
      else { tap = null; pinch = null; }
    });
    cv.addEventListener('pointermove', (e) => {
      if (!ptrs.has(e.pointerId)) return;
      const prev = ptrs.get(e.pointerId), cur = pos(e);
      if (ptrs.size === 1) {
        if (tap && Math.hypot(cur[0] - tap.x, cur[1] - tap.y) > 8) tap.moved = true;
        if (!tap || tap.moved) this.cam.panBy(prev[0], prev[1], cur[0], cur[1]);
      } else if (ptrs.size === 2) {
        const ids = [...ptrs.keys()];
        const other = ptrs.get(ids[0] === e.pointerId ? ids[1] : ids[0]);
        const d0 = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
        const d1 = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
        const m0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2], m1 = [(cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2];
        if (d1 > 10 && d0 > 10) this.cam.zoomAt(m1[0], m1[1], d0 / d1);
        this.cam.panBy(m0[0], m0[1], m1[0], m1[1]);
      }
      ptrs.set(e.pointerId, cur);
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (tap && !tap.moved && performance.now() - tap.t < 500 && e.type === 'pointerup') this.onTap(e.clientX, e.clientY);
      tap = null; pinch = null;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 0.05 : 0.0015;
      this.cam.zoomAt(e.clientX, e.clientY, Math.exp(e.deltaY * k));
    }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('resize', () => this.resize());
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    this.keys = new Set();
    window.addEventListener('keyup', (e) => this.keys.delete(e.key));
    // フォーカスが外れると keyup が来ないので、押しっぱなし扱いを解除
    window.addEventListener('blur', () => this.keys.clear());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.keys.clear(); });
    // スマホでアプリ切り替え時などに WebGL コンテキストが失われたら作り直す
    cv.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.glLost = true; });
    cv.addEventListener('webglcontextrestored', () => this.restoreGL());
  },
  onKey(e) {
    if (e.target && e.target.tagName === 'INPUT') return;
    this.keys.add(e.key);
    const k = e.key;
    if (k === '+' || k === '=' || k === ';') this.cam.zoomAt(this.w / 2, this.h / 2, 0.8);
    else if (k === '-' || k === '_') this.cam.zoomAt(this.w / 2, this.h / 2, 1.25);
    else if (k === 'Escape') {
      // モーダルは「既定のボタン」と同じ動きにする（日報なら翌日へ進む）
      if (!$('modal').classList.contains('hidden')) { if (this.state === STATE.PLAYING && this.modalEsc) this.modalEsc(); }
      else this.hidePanel();
    }
    if (this.state !== STATE.PLAYING || this.paused) return;
    if (k === 't' || k === 'T') this.toggleTop();
    else if (k === 'h' || k === 'H') this.goHome();
    else if (k === 'u' || k === 'U' || k === ' ') this.goUnit();
    else if (k === 'f' || k === 'F') this.onFort();
  },
  keyPan(dt) {
    if (!this.keys || !this.keys.size) return;
    let dx = 0, dy = 0;
    for (const k of this.keys) {
      if (k === 'ArrowLeft' || k === 'a') dx -= 1;
      if (k === 'ArrowRight' || k === 'd') dx += 1;
      if (k === 'ArrowUp' || k === 'w') dy -= 1;
      if (k === 'ArrowDown' || k === 's') dy += 1;
    }
    if (dx || dy) {
      const sp = this.cam.dist * 0.9 * dt;
      this.cam.goal = null;
      this.cam.tx += dx * sp; this.cam.tz += dy * sp;
      this.cam.clampTarget();
    }
  },
  pickCell(sx, sy) {
    const p = this.cam.groundAt(sx, sy);
    if (!p) return -1;
    const x = Math.floor(p.x), y = Math.floor(p.z);
    if (x < 0 || y < 0 || x >= this.map.W || y >= this.map.H) return -1;
    return y * this.map.W + x;
  },
  restoreGL() {
    try {
      this.renderer = new Renderer($('gl'), this.map);
      this.renderer.setPalette(this.map.paletteColors());
      this.renderer.uploadTerrain();
      this.renderer.attachGame(this.game, this.game ? this.me : 0);
      this.resize();
      this.glLost = false;
    } catch (e) {
      console.error(e);
      window.__jinchiError = e.message;
    }
  },
  resize() {
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, CONFIG.MAX_DPR);
    this.cam.setViewport(this.w, this.h);
    if (this.renderer) this.renderer.resize(this.w, this.h, this.dpr);
  },

  // ------------------------------------------------ ゲームループ
  drawMinimapFrame() {
    // 画像は再計算せず、枠だけ描き直す
    if (!this.mmImage) return;
    const saved = this.minimapDirty;
    this.minimapDirty = false;
    this.drawMinimap();
    this.minimapDirty = saved;
  },

  start() {
    this.resize();
    this.setState(STATE.LOADING);
    requestAnimationFrame((t) => { this.lastT = t; this.frame(t); });
  },
};

// テスト・デバッグ用
window.__jinchi = { App, CONFIG, STATE, get game() { return App.game; } };
App.start();
