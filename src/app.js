// =====================================================================
// アプリ本体（ステートマシン）
// =====================================================================
const STATE = { LOADING: 'LOADING', TITLE: 'TITLE', PLAYING: 'PLAYING', GAMEOVER: 'GAMEOVER' };
// オンライン版（online.html）：サーバーが細かい地図（元の地図の1マスを S×S）とルールを持つ
const ONLINE = window.JINCHI_ONLINE || null;

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
      if (ONLINE) { this.map = scaledMap(this.map, ONLINE.S); CONFIG.ZOOM_MAX *= ONLINE.S; }
      progress(0.5, '3D描画を準備中…'); await nextFrame();
      this.renderer = new Renderer($('gl'), this.map);
      this.cam.bounds = [0, 0, this.map.W, this.map.H];
      this.renderer.setPalette(this.map.paletteColors());
      progress(0.65, '地形テクスチャを作成中…'); await nextFrame();
      this.renderer.uploadTerrain();
      if (!this.painter) this.painter = new SoldierPainter().paint();   // 兵士の絵を描く（初回だけ）
      this.renderer.uploadSprites(this.painter);
      if (!this.groundPainter) this.groundPainter = new GroundPainter().paint();   // 草の筋の絵
      this.renderer.uploadGround(this.groundPainter);
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
    if (fly) this.flyToPref(p, 700 * (this.map.scale || 1), 0.3);
  },
  flyToPref(p, dist, anchorY) {
    const c = this.map.capitalCell[p];
    this.cam.flyTo(this.map.X(c) + 0.5, this.map.Y(c) + 0.5, dist, anchorY);
  },
  resetCamera(instant) {
    const W = this.map.W, H = this.map.H;
    const aspect = this.w / this.h;
    const th = Math.tan(this.cam.fovY / 2);
    // タイトルでは下のシートに隠れないよう、画面上側に日本全体を出す
    const title = this.state === STATE.TITLE || this.state === STATE.LOADING || !this.state;
    // タイトル：見出しと下のシートの間（画面の約12%〜48%）に沖縄まで含めた日本全体を収める
    const band = title ? 0.36 : 0.62;
    const dist = clamp(Math.max(W * (title ? 1.0 : 0.85) / (2 * th * aspect), H / (band * 2 * th)), 500 * (this.map.scale || 1), CONFIG.ZOOM_MAX);
    this.cam.flyTo(W * 0.5, H * 0.5, dist, title ? 0.29 : 0.5);
    if (instant) { const g = this.cam.goal; this.cam.tx = g.x; this.cam.tz = g.z; this.cam.dist = g.dist; this.cam.goal = null; }
  },

  // ------------------------------------------------ PLAYING
  startGame(p) {
    if (ONLINE) return this.startOnline(p);
    this.me = p;
    const seedParam = new URLSearchParams(location.search).get('seed');
    const seed = seedParam ? +seedParam : (Date.now() & 0x7fffffff);
    this.game = new Sim(this.map, p, seed);
    // 確認用の早送り（例：?speed=600 で 1秒＝10分）
    this.speed = clamp(+(new URLSearchParams(location.search).get('speed') || 1), 1, 5000);
    this.renderer.attachGame(this.game, p);
    this.setState(STATE.PLAYING);
  },

  // ------------------------------------------------ GAMEOVER

  // ------------------------------------------------ HUD / パネル
  enterPLAYING(signal) {
    const g = this.game, map = this.map;
    $('hud').classList.remove('hidden');
    $('log').innerHTML = '';
    this.sel = null; this.paused = false; this.topView = false; this.hudT = 0; this.mode = null; this.treeKey = '';
    this.cam.pitchGoal = CONFIG.CAMERA_PITCH;
    $('btn-top').classList.remove('on'); $('toplabel').classList.add('hidden');
    this.hidePanel();
    const pr = map.prefs[this.me];
    $('h-chip').style.background = pr.color;
    $('h-pref').textContent = pr.name;
    this.buildMenu();
    this.goHome(48);   // 最初は自県の都を大きく映す
    // シミュレーションのイベント
    g.on('cells', (cells) => { for (const i of cells) this.renderer.cellChanged(i); this.minimapDirty = true; });
    g.on('capture', (e) => this.onCapture(e));
    g.on('built', (e) => {
      if (!e.byPlayer) return;
      const def = BUILDINGS[e.type];
      this.log(`${def.icon} ${def.name}を建てました`, 'good', (e.building || e.node).cell);
    });
    this.corpses = []; this.anim = new Map();
    g.on('death', (u) => {
      const s = this.anim && this.anim.get(u.id);
      if (this.corpses.length < 300) this.corpses.push({ x: u.x, z: u.y, yaw: s ? s.yaw : 0, kind: (u.id % 3 !== 0 ? 0 : 2), col: this.colCache ? this.colCache[u.pref] : [0.5, 0.5, 0.5], t: this.clock });
    });
    g.on('destroyed', (b) => { if (b.owner === this.me) this.log(`🔥 ${BUILDINGS[b.type].name}が壊されました`, 'bad', b.cell); if (this.sel && this.sel.b === b) this.hidePanel(); });
    g.on('flipped', (e) => { if (e.from === this.me) this.log(`⚠ ${BUILDINGS[e.building.type].name}を${map.prefs[e.to].name}に奪われました`, 'bad', e.building.cell); });
    g.on('eliminated', (p) => { if (p !== this.me) this.log(`${map.prefs[p].name}が全ての拠点を失い、脱落しました`, 'bad', -1); });
    g.on('buildfail', (m) => { this.marker = { x: m.x, z: m.y, t: this.clock, ok: false }; this.showBuildFail(m.why); });
    g.on('net', (s) => { if (s === 'down') this.banner('接続が切れました', 'ng', 'つなぎ直しています…'); else this.banner('再接続しました', 'ok', ''); });
    g.on('over', () => setTimeout(() => { if (this.state === STATE.PLAYING) this.setState(STATE.GAMEOVER); }, 900));
    // UI イベント
    $('buildmenu').addEventListener('click', (e) => {
      const b = e.target.closest('[data-b]');
      if (b) this.startPlace(b.dataset.b);
    }, { signal });
    $('btn-rally').addEventListener('click', () => this.toggleRallyMode(), { signal });
    $('btn-cancel').addEventListener('click', () => this.setMode(null), { signal });
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
    signal.addEventListener('abort', () => { this.hidePanel(); this.setMode(null); });
    this.updateHud(true);
    this.log(ONLINE ? `出陣！ ${pr.name}の一員として参加しました。人のいない席はAIが担当します。下のメニューから建物を建てよう`
      : `出陣！ ${pr.name}の参加者${g.parts[this.me]}人（あなた＋AI）。下のメニューから建物を建てよう`, 'good', -1);
  },
  /** 下の建築メニュー（カード） */
  buildMenu() {
    let html = '';
    for (const k of BUILD_ORDER) {
      const d = BUILDINGS[k];
      const cost = RES_KEYS.filter((r) => d.cost[r]).map((r) => `<span data-r="${r}">${RES_ICON[r]}${d.cost[r]}</span>`).join('');
      html += `<button class="bcard" data-b="${k}" title="${escapeHtml(d.desc)}"><i>${d.icon}</i><b>${d.name}</b><small>${cost}</small></button>`;
    }
    $('buildmenu').innerHTML = html;
  },
  startPlace(type) {
    const g = this.game;
    if (!g.canAfford(0, BUILDINGS[type].cost)) { this.banner('資源が足りません', 'ng', this.costText(BUILDINGS[type].cost)); return; }
    this.setMode(this.mode && this.mode.type === type ? null : { kind: 'place', type });
  },
  toggleRallyMode() { this.setMode(this.mode && this.mode.kind === 'rally' ? null : { kind: 'rally' }); },
  setMode(m) {
    this.mode = m;
    for (const b of document.querySelectorAll('.bcard')) b.classList.toggle('on', !!(m && m.kind === 'place' && b.dataset.b === m.type));
    $('btn-rally').classList.toggle('on', !!(m && m.kind === 'rally'));
    $('btn-cancel').classList.toggle('hidden', !m);
    const hint = $('hint');
    if (!m) { hint.classList.add('hidden'); return; }
    hint.classList.remove('hidden');
    if (m.kind === 'place') {
      const d = BUILDINGS[m.type];
      hint.textContent = `${d.icon} ${d.name}：自県の領土（明るいところ）をタップして建てる — ${d.desc}`;
    } else hint.textContent = '⚔ 攻撃目標：あなたの兵舎の兵士を向かわせる敵の拠点をタップ（自県の拠点をタップで解除）';
  },
  costText(cost) { return RES_KEYS.filter((r) => cost[r]).map((r) => `${RES_NAME[r]}${cost[r]}`).join('・'); },
  onCapture(e) {
    const map = this.map, me = this.me, n = e.node;
    if (e.from === me) {
      this.log(`⚠ ${n.name}を${map.prefs[e.by].name}に奪われました（−${fmt(e.cells)}マス）`, 'bad', n.cell);
      if (n.type === 'capital') this.banner('県庁を奪われた！', 'ng', `${map.prefs[e.by].name}に占領されました`);
    } else if (e.by === me) {
      this.log(`🚩 ${n.name}を占領しました（+${fmt(e.cells)}マス）`, 'good', n.cell);
      if (n.id === this.game.rally || n.type === 'capital') this.banner(n.type === 'capital' ? `${map.prefs[n.pref].short}県庁を占領！` : '占領成功！', 'ok', `${n.name}（+${fmt(e.cells)}マス）`);
      if (n.id === this.game.rally) this.game.setRally(-1);
    }
    if (this.sel && this.sel.n === n) this.updatePanel();
  },
  goHome(dist) {
    const g = this.game, cap = g.nodes[this.me - 1];
    const n = cap.owner === this.me ? cap : g.nodes.find((q) => q.owner === this.me);
    if (n) this.cam.flyTo(n.x, n.y, dist || 300, 0.42);
  },
  toggleTop() {
    this.topView = !this.topView;
    this.cam.pitchGoal = this.topView ? CONFIG.TOP_PITCH : CONFIG.CAMERA_PITCH;
    $('btn-top').classList.toggle('on', this.topView);
    $('toplabel').classList.toggle('hidden', !this.topView);
  },
  confirmTitle() {
    this.openModal('タイトルに戻りますか？', `<p style="text-align:center">${ONLINE ? 'あなたの建物と資源はサーバーに残ります（同じ端末で続きから遊べます）。' : '今のゲームの進行は失われます。'}</p>`, [
      { label: 'やめる', fn: () => this.closeModal() },
      { label: 'タイトルへ', cls: 'warn', fn: () => { this.closeModal(); this.setState(STATE.TITLE); } },
    ]);
  },
  /** ゲーム内の時刻（DAY 3 14:05） */
  fmtTime(t) {
    const s = Math.floor(t), d = Math.floor(s / 86400) + 1, h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
    return `DAY${d} ${h}:${String(m).padStart(2, '0')}`;
  },
  fmtLeft(t) {
    const left = Math.max(0, CONFIG.SEASON_DAYS * 86400 - t), d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600);
    return d ? `残り${d}日${h}時間` : `残り${h}時間${Math.floor((left % 3600) / 60)}分`;
  },

  // ------------------------------------------------ GAMEOVER
  /** オンライン：サーバーにつないで参加（同じ端末なら前回の続き）。届いた県で始める */
  async startOnline(p) {
    if (this.joining) return;
    this.joining = true;
    $('btn-start').disabled = true;
    this.banner('サーバーに接続中…', 'def', '');
    const url = ONLINE.url || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
    const g = new NetGame(this, url);
    try {
      const w = await g.join(p, ONLINE.name || '');
      this.me = w.pref;
      this.game = g;
      this.speed = 1;
      this.renderer.attachGame(g, this.me);
      this.setState(STATE.PLAYING);
      if (w.pref !== p) this.banner(`今シーズンは${this.map.prefs[w.pref].name}で参加中`, 'def', '1シーズンに参加できる県は1つです');
    } catch (e) {
      g.dispose();
      this.banner('接続できません', 'ng', e.message);
    } finally {
      this.joining = false;
      $('btn-start').disabled = false;
    }
  },
  enterGAMEOVER(signal) {
    const g = this.game, map = this.map, o = g.over;
    this.hidePanel(); this.setMode(null);
    let head, cls, detail;
    if (o.win && o.reason !== 'season') { head = '天下統一！'; cls = 'win'; detail = `${map.prefs[this.me].name}が全国の人口の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else if (o.reason === 'rival') { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[o.rival].name}が全国の人口の${Math.round(CONFIG.WIN_RATIO * 100)}%を支配しました。`; }
    else if (o.reason === 'season') {
      head = o.win ? 'シーズン優勝！' : 'シーズン終了';
      cls = o.win ? 'win' : 'lose';
      detail = o.win ? `${CONFIG.SEASON_DAYS}日間を戦い抜き、${map.prefs[this.me].name}が全国1位になりました。` : `${CONFIG.SEASON_DAYS}日間が終わりました。優勝は${map.prefs[o.rival].name}です。`;
    } else { head = '敗北…'; cls = 'lose'; detail = `${map.prefs[this.me].name}は全ての拠点を失いました。`; }
    const body = `<div class="result-big ${cls}">${head}</div><p style="text-align:center">${detail}<br>経過 ${this.fmtTime(o.time)}・最終領土 ${fmt(g.counts[this.me])}マス・${g.rankOf(this.me)}位<br>あなたが建てた建物 ${g.myBuildings()}</p>`;
    this.openModal('ゲーム終了', body, [{ label: 'タイトルへ', cls: 'primary', fn: () => this.setState(STATE.TITLE) }]);
    signal.addEventListener('abort', () => { this.closeModal(); $('hud').classList.add('hidden'); });
  },

  // ------------------------------------------------ HUD / パネル
  updateHud(force) {
    const g = this.game;
    if (!g) return;
    if (!force && this.clock - (this.hudT || 0) < CONFIG.HUD_REFRESH) return;
    this.hudT = this.clock;
    const me = this.me;
    $('h-time').textContent = `⏱ ${this.fmtTime(g.time)}`;
    $('h-left').textContent = this.fmtLeft(g.time) + (this.speed > 1 ? `（×${this.speed}）` : '');
    $('h-rank').textContent = g.rankOf(me) + '位';
    for (const r of RES_KEYS) {
      $('r-' + r).textContent = fmt(Math.floor(g.res[r][0]));
      $('ri-' + r).textContent = `+${Math.round(g.income[r] * 3600)}/時`;   // 1時間あたりの収入
    }
    $('r-units').textContent = `${g.myUnits()}`;
    const c = g.counts[me], d = c - this.map.initCounts[me];
    $('h-cells').textContent = fmt(c);
    const dEl = $('h-delta');
    dEl.textContent = `(${d > 0 ? '+' : d < 0 ? '−' : '±'}${fmt(Math.abs(d))})`;
    dEl.className = d > 0 ? 'up' : d < 0 ? 'down' : '';
    $('h-today').textContent = `人口 ${fmt(Math.round(g.pop[me]))}万（${(g.pop[me] / g.popTotal * 100).toFixed(1)}%）・拠点 ${g.nodeCount[me]}・兵士 ${g.unitCount(me)}/${g.unitCap(me)}・あなたの建物 ${g.myBuildings()}${ONLINE ? `・接続中 ${fmt(g.online)}人` : ''}`;
    // 建築カード：資源が足りないものは暗く
    for (const b of document.querySelectorAll('.bcard')) b.classList.toggle('poor', !g.canAfford(0, BUILDINGS[b.dataset.b].cost));
    const rn = g.rally >= 0 ? g.nodes[g.rally] : null;
    $('btn-rally').innerHTML = rn ? `⚔ 目標：${escapeHtml(rn.name)}` : '⚔ 攻撃目標';
    if (this.sel) this.updatePanel();
  },
  hidePanel() { this.sel = null; $('cellpanel').classList.add('hidden'); },
  select(sel) { this.sel = sel; $('cellpanel').classList.remove('hidden'); this.updatePanel(); },
  updatePanel() {
    const g = this.game, map = this.map, s = this.sel;
    if (!g || !s) return;
    if (s.n) {
      const n = s.n;
      $('cp-name').textContent = n.name;
      $('cp-chip').style.background = map.prefs[n.owner].color;
      $('cp-owner').textContent = `持ち主：${map.prefs[n.owner].name}${n.owner === this.me ? '（自県）' : ''}・${NODE_TYPE_NAME[n.type]}${n.byPlayer && n.owner === this.me ? '（あなたが建設）' : ''}`;
      $('cp-meta').textContent = `領土 ${fmt(g.cellsOf(n.id).length)}マス・守備 ${n.defenders}・攻撃 ${n.attackers}${n.pref !== n.owner ? `・元は${map.prefs[n.pref].name}` : ''}`;
      let note = '';
      if (n.capBy) note = `🚩 ${map.prefs[n.capBy].name}が占領中 ${Math.floor(n.progress / g.needFor(n) * 100)}%`;
      else if (n.attackers && n.defenders) note = '⚔ 交戦中';
      else if (n.owner !== this.me) note = '「⚔ 攻撃目標」でここを指定すると、あなたの兵舎の兵士が攻めに行きます';
      $('cp-note').textContent = note;
    } else if (s.b) {
      const b = s.b, d = BUILDINGS[b.type];
      $('cp-name').textContent = `${d.icon} ${d.name}`;
      $('cp-chip').style.background = map.prefs[b.owner].color;
      $('cp-owner').textContent = `持ち主：${map.prefs[b.owner].name}${b.wallet === 0 ? '（あなた）' : ''}`;
      $('cp-meta').textContent = `耐久 ${Math.max(0, Math.ceil(b.hp))}/${b.maxHp}・${d.desc}`;
      let note = '';
      if (b.type === 'barracks') note = `訓練 ${Math.min(100, Math.floor(b.t / d.train * 100))}%（食料${d.trainFood}）`;
      if (b.type === 'farm' && b.mul < 1) note = '森を切り開いた農場（収穫は半分）';
      if (b.type === 'lumber') note = `周りの森 ${b.forest}か所 → 木材 +${Math.round(Math.min(CONFIG.LUMBER_MAX, b.forest * CONFIG.LUMBER_PER_FOREST) * 3600)}/時`;
      $('cp-note').textContent = note;
    }
  },
  focusCell(i) { this.cam.flyTo(this.map.X(i) + 0.5, this.map.Y(i) + 0.5, Math.min(this.cam.dist, 160), 0.42); },
  showRanking() {
    const g = this.game, map = this.map;
    const rows = g.ranking().map((p, k) => {
      const c = g.counts[p], d = c - map.initCounts[p];
      const cls = (p === this.me ? ' me' : '') + (g.nodeCount[p] === 0 ? ' dead' : '');
      return `<div class="rank-row${cls}"><span class="no">${k + 1}</span><span class="chip" style="background:${map.prefs[p].color}"></span>` +
        `<span class="nm">${map.prefs[p].name}${g.nodeCount[p] === 0 ? '（脱落）' : ''}<small class="sub">拠点${g.nodeCount[p]}・兵士${g.unitCount(p)}・建物${g.buildings.filter((b) => b.owner === p).length}</small></span>` +
        `<span class="ct">${fmt(c)}<small class="${d >= 0 ? 'plus' : 'minus'}"> ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))}</small></span>` +
        `<span class="pc">${fmt(Math.round(g.pop[p]))}万<br>${(g.pop[p] / g.popTotal * 100).toFixed(1)}%</span></div>`;
    }).join('');
    this.openModal(`戦況（${this.fmtTime(g.time)}・支配人口順）`, rows, [{ label: '閉じる', fn: () => this.closeModal() }]);
  },

  // ------------------------------------------------ 3D：建物・兵士・木（日本風）
  buildScene() {
    const g = this.game, map = this.map, cam = this.cam;
    const KINDS = ['pad', 'shadow', 'box', 'boxW', 'roof', 'roofT', 'cone', 'coneT', 'cyl', 'cylW', 'sphere', 'sphereT'];
    if (!this.inst) { this.inst = {}; for (const k of KINDS) this.inst[k] = new InstanceList(); }
    const I = this.inst;
    for (const k in I) I[k].clear();
    this.smoke = [];
    const v = [0, 0], m = 60;
    const visible = (x, z) => cam.project(x, 0, z, v) && v[0] > -m && v[0] < this.w + m && v[1] > -m && v[1] < this.h + m;
    if (!this.colCache) this.colCache = map.prefs.map((p) => (p ? hexToRgb(p.color).map((q) => q / 255) : [0, 0, 0]));
    const col = this.colCache;
    const cpx = cam.cellPx();
    const detail = cpx > 2.6;                         // 拡大したときだけ細かいモデル
    const big = clamp(cam.dist * 0.0016, 0.9, 7);    // 引いているときは大きめに（見つけやすく）
    const C = {
      wood: [0.42, 0.29, 0.18], woodDk: [0.3, 0.2, 0.13], woodLt: [0.66, 0.5, 0.32], plaster: [0.93, 0.9, 0.82],
      thatch: [0.7, 0.58, 0.34], thatchDk: [0.56, 0.45, 0.28], kawara: [0.38, 0.39, 0.43], stone: [0.66, 0.64, 0.58], stoneDk: [0.5, 0.48, 0.44],
      dirt: [0.58, 0.48, 0.32], dirt2: [0.66, 0.58, 0.42], crop: [0.48, 0.64, 0.22], crop2: [0.84, 0.72, 0.3], hay: [0.9, 0.74, 0.32],
      water: [0.3, 0.5, 0.55], skin: [0.92, 0.78, 0.62], gun: [0.18, 0.16, 0.14], dark: [0.15, 0.13, 0.12], lantern: [0.95, 0.75, 0.4],
      red: [0.72, 0.2, 0.15], green: [0.3, 0.55, 0.2],
    };
    let cx = 0, cz = 0, rot = 0, cs = 1, sn = 0, S = 1, OC = C.red;
    const at = (x, z, r, s, oc) => { cx = x; cz = z; rot = r; cs = Math.cos(r); sn = Math.sin(r); S = s; OC = oc || C.red; };
    const P = (mesh, lx, ly, lz, sx, sy, sz, c, r2, tilt) => {
      const wx = cx + (lx * cs - lz * sn) * S, wz = cz + (lx * sn + lz * cs) * S;
      I[mesh].push(wx, ly * S, wz, sx * S, sy * S, sz * S, c, rot + (r2 || 0), tilt || 0);
    };
    const pad = (lx, lz, w, d, c) => P('pad', lx, 0.015, lz, w, 0.01, d, c || C.dirt);
    const shadow = (w, d) => I.shadow.push(cx + 0.35 * S, 0.02, cz - 0.4 * S, w * 1.25 * S, 0.01, d * 1.25 * S, [0, 0, 0], rot);   // 影は奥・右へ
    const smokeAt = (lx, ly, lz) => { if (this.smoke.length < 80) this.smoke.push([cx + (lx * cs - lz * sn) * S, ly * S, cz + (lx * sn + lz * cs) * S]); };
    // 日本家屋：高床の縁側・板壁・持ち主の色の帯・深い軒の屋根（茅葺き or 瓦）
    const minka = (lx, lz, w, d, h, roofC, r2, opt = {}) => {
      if (detail) P('boxW', lx, 0, lz, w * 1.12, h * 0.12, d * 1.12, C.woodDk, r2);
      P('boxW', lx, detail ? h * 0.12 : 0, lz, w, h * (detail ? 0.88 : 1), d, opt.wall || C.wood, r2);
      if (detail) {
        P('box', lx, h * 0.9, lz, w * 1.02, h * 0.08, d * 1.02, OC, r2);   // 持ち主の色の帯
        // 戸・障子（明るい格子）
        const ox = Math.cos(r2 || 0), oz = Math.sin(r2 || 0);
        P('box', lx - oz * 0 + ox * 0, h * 0.18, lz + d * 0.505, w * 0.36, h * 0.5, 0.02, C.plaster, r2);
        P('box', lx, h * 0.18, lz + d * 0.51, 0.02, h * 0.5, 0.02, C.woodDk, r2);
        if (opt.lantern) { P('cylW', lx + w * 0.62, 0, lz + d * 0.7, 0.04, h * 0.7, 0.04, C.woodDk); P('sphere', lx + w * 0.62, h * 0.7, lz + d * 0.7, 0.16, 0.2, 0.16, C.lantern); }
      }
      P('roofT', lx, h, lz, w * 1.3, h * 0.85, d * 1.35, roofC, r2);
      if (detail) P('box', lx, h * 1.82, lz, w * 1.2, h * 0.07, 0.08, C.woodDk, r2);   // 棟
    };
    const flag = (lx, lz, h, c) => {   // のぼり旗
      P('cylW', lx, 0, lz, 0.05, h, 0.05, C.woodDk);
      P('box', lx + 0.13, h * 0.45, lz, 0.22, h * 0.5, 0.02, c);
    };
    const yagura = (lx, lz, s2, roofC) => {   // 物見櫓（4本脚）
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) P('cylW', lx + a * 0.3 * s2, 0, lz + b * 0.3 * s2, 0.07 * s2, 1.7 * s2, 0.07 * s2, C.wood);
      P('boxW', lx, 1.5 * s2, lz, 0.8 * s2, 0.4 * s2, 0.8 * s2, C.wood);
      P('box', lx, 1.85 * s2, lz, 0.82 * s2, 0.06 * s2, 0.82 * s2, OC);
      P('roofT', lx, 1.9 * s2, lz, 1.05 * s2, 0.45 * s2, 1.05 * s2, roofC);
    };
    const tenshu = (lx, lz, s2) => {   // 天守：石垣・白壁・黒瓦の三層
      P('box', lx, 0, lz, 2.0 * s2, 0.55 * s2, 1.7 * s2, C.stone);
      if (detail) P('box', lx, 0.5 * s2, lz, 2.06 * s2, 0.06 * s2, 1.76 * s2, C.stoneDk);
      let y = 0.55 * s2, w = 1.6 * s2, d = 1.35 * s2;
      for (let k = 0; k < 3; k++) {
        const h = (k === 0 ? 0.6 : 0.45) * s2;
        P('boxW', lx, y, lz, w, h, d, C.plaster);
        if (detail) { P('box', lx, y + h * 0.45, lz + d * 0.505, w * 0.7, h * 0.18, 0.02, C.dark); P('box', lx, y + h * 0.88, lz, w * 1.02, h * 0.1, d * 1.02, OC); }
        P('roof', lx, y + h, lz, w * 1.35, 0.35 * s2, d * 1.4, C.kawara);
        y += h + 0.25 * s2; w *= 0.72; d *= 0.72;
      }
      if (detail) { P('box', lx - w * 0.6, y - 0.05 * s2, lz, 0.12 * s2, 0.2 * s2, 0.06 * s2, [0.85, 0.7, 0.25]); P('box', lx + w * 0.6, y - 0.05 * s2, lz, 0.12 * s2, 0.2 * s2, 0.06 * s2, [0.85, 0.7, 0.25]); }
    };
    // ---- 拠点
    const nodes = g ? g.nodes : map.prefs.filter(Boolean).map((p) => ({ x: map.X(p.capital) + 0.5, y: map.Y(p.capital) + 0.5, owner: p.id, type: 'capital' }));
    for (const n of nodes) {
      if (!visible(n.x, n.y)) continue;
      const c = col[n.owner];
      if (n.type === 'capital') {
        // 都：堀・石垣の天守・城下町
        at(n.x, n.y, 0, big * 1.15, c);
        pad(0, 0, 6.2, 5.6, C.dirt2);
        shadow(4.4, 4.0);
        if (detail) { P('box', 0, 0.01, -1.9, 3.6, 0.03, 0.35, C.water); P('box', 0, 0.01, 1.9, 3.6, 0.03, 0.35, C.water); }
        tenshu(0, -0.2, 1.0);
        const ring = detail ? 12 : 6;
        for (let k = 0; k < ring; k++) {
          const a = k / ring * Math.PI * 2 + 0.25, rr = 2.35 + (k % 2) * 0.35;
          minka(Math.cos(a) * rr, Math.sin(a) * rr, 0.7, 0.55, 0.5 + (k % 3) * 0.06, k % 3 ? C.kawara : C.thatch, -a + Math.PI / 2, { lantern: k % 4 === 0 });
          if (k % 3 === 0) smokeAt(Math.cos(a) * rr, 1.0, Math.sin(a) * rr);
        }
        flag(1.15, 0.95, 1.9, c); flag(-1.15, 0.95, 1.9, c);
      } else if (n.type === 'town') {
        // 町：寺（本堂・五重塔）と町家
        at(n.x, n.y, (n.x * 7.1 + n.y) % 6.28, big * 0.9, c);
        pad(0, 0, 4.0, 3.6);
        shadow(3.0, 2.8);
        minka(-0.25, -0.1, 1.1, 0.85, 0.7, C.kawara, 0);
        // 五重塔
        let y = 0, w = 0.62;
        for (let k = 0; k < (detail ? 5 : 3); k++) {
          P('boxW', 0.75, y, -0.6, w * 0.7, 0.3, w * 0.7, C.wood);
          P('roof', 0.75, y + 0.3, -0.6, w * 1.25, 0.16, w * 1.25, C.kawara);
          y += 0.42; w *= 0.88;
        }
        P('cylW', 0.75, y, -0.6, 0.04, 0.5, 0.04, [0.8, 0.65, 0.25]);
        const k0 = detail ? 8 : 4;
        for (let k = 0; k < k0; k++) {
          const a = k / k0 * Math.PI * 2 + 0.6, rr = 1.45 + (k % 2) * 0.3;
          minka(Math.cos(a) * rr, Math.sin(a) * rr, 0.6, 0.48, 0.42 + (k % 3) * 0.06, k % 2 ? C.thatch : C.kawara, -a + Math.PI / 2, { lantern: k === 2 });
        }
        flag(-0.9, 0.7, 1.5, c);
      } else {
        // 砦：石垣の上の白い塀・四隅の櫓・中央の天守
        at(n.x, n.y, 0, big * 1.0, c);
        pad(0, 0, 4.0, 4.0, C.dirt2);
        shadow(3.3, 3.3);
        for (let k = 0; k < 4; k++) {
          const a = k * Math.PI / 2, ox = Math.cos(a) * 1.35, oz = Math.sin(a) * 1.35, wx = k % 2 ? 0.3 : 2.7, wz = k % 2 ? 2.7 : 0.3;
          P('box', ox, 0, oz, wx, 0.4, wz, C.stone);
          P('boxW', ox, 0.4, oz, wx * (k % 2 ? 0.6 : 1), 0.3, wz * (k % 2 ? 1 : 0.6), C.plaster);
          P('roof', ox, 0.7, oz, wx * (k % 2 ? 0.9 : 1.02), 0.15, wz * (k % 2 ? 1.02 : 0.9), C.kawara, k % 2 ? Math.PI / 2 : 0);
        }
        for (const [tx, tz] of [[1.35, 1.35], [-1.35, 1.35], [1.35, -1.35], [-1.35, -1.35]]) yagura(tx, tz, 0.55, C.kawara);
        tenshu(0, 0, 0.55);
        flag(0.5, 0.9, 1.8, c);
      }
    }
    if (g) {
      // ---- 建物
      const t = this.clock;
      for (const b of g.buildings) {
        if (cpx < 0.3 || !visible(b.x, b.y)) continue;
        const c = col[b.owner];
        at(b.x, b.y, b.rot, big * 0.8, c);
        switch (b.type) {
          case 'farm': {
            // 区画に分かれた畑と稲わらの束、農家
            pad(0, 0, 3.2, 2.6, C.dirt);
            shadow(1.4, 1.2);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) {
              const px = -1.0 + i * 0.85, pz = -0.15 + j * 0.85, cc = (i + j + b.id) % 3 === 0 ? C.crop2 : C.crop;
              P('box', px, 0.02, pz, 0.78, 0.05, 0.78, cc);
              if (detail) for (let r = 0; r < 4; r++) P('box', px - 0.28 + r * 0.19, 0.06, pz, 0.08, 0.06, 0.7, [cc[0] * 0.8, cc[1] * 0.85, cc[2] * 0.8]);
            }
            if (detail) for (let k = 0; k < 4; k++) P('cylW', -0.9 + k * 0.6, 0.12, 1.15, 0.24, 0.5, 0.24, C.hay, Math.PI / 2);
            minka(0.95, -0.95, 0.85, 0.6, 0.5, C.thatch, 0);
            break;
          }
          case 'lumber':
            pad(0, 0, 2.6, 2.0);
            shadow(1.8, 1.4);
            minka(-0.3, -0.1, 1.0, 0.75, 0.55, C.thatchDk, 0);
            for (let k = 0; k < 3; k++) for (let q = 0; q < 3 - k; q++) P('cylW', 0.9 + q * 0.2 + k * 0.1, 0.1 + k * 0.17, 0.6, 0.18, 0.95, 0.18, C.woodLt, Math.PI / 2);
            if (detail) { P('cylW', -0.9, 0, 0.75, 0.32, 0.22, 0.32, C.woodLt); P('boxW', 0.9, 0, -0.55, 0.55, 0.3, 0.18, C.wood); }
            break;
          case 'market': {
            pad(0, 0, 2.8, 2.4, C.dirt2);
            shadow(2.0, 1.8);
            minka(0, -0.45, 1.1, 0.75, 0.6, C.kawara, 0, { lantern: true });
            const aw = [[0.78, 0.22, 0.18], [0.22, 0.4, 0.7], [0.88, 0.75, 0.25], [0.25, 0.55, 0.3]];
            for (let k = 0; k < 4; k++) {
              const sx = -0.9 + k * 0.6, sz = 0.7;
              P('boxW', sx, 0, sz, 0.42, 0.28, 0.35, C.woodLt);
              P('roof', sx, 0.42, sz, 0.55, 0.15, 0.5, aw[k]);
              if (detail) { P('cylW', sx - 0.22, 0, sz + 0.2, 0.03, 0.42, 0.03, C.woodDk); P('cylW', sx + 0.22, 0, sz + 0.2, 0.03, 0.42, 0.03, C.woodDk);
                P('sphere', sx, 0.28, sz, 0.18, 0.12, 0.18, k % 2 ? [0.85, 0.35, 0.2] : [0.6, 0.75, 0.3]); }
            }
            break;
          }
          case 'barracks':
            // 兵舎：長屋と練兵場の柵
            pad(0, 0.2, 3.0, 2.6, C.dirt2);
            shadow(2.4, 1.8);
            minka(0, -0.45, 2.0, 0.8, 0.6, C.kawara, 0);
            if (detail) {
              for (let k = 0; k < 9; k++) P('cylW', -1.1 + k * 0.275, 0, 1.15, 0.05, 0.28, 0.05, C.woodLt);
              P('boxW', 0, 0.2, 1.15, 2.2, 0.04, 0.04, C.woodLt);
              P('boxW', -1.1, 0.2, 0.7, 0.04, 0.04, 0.9, C.woodLt);
              P('boxW', 1.1, 0.2, 0.7, 0.04, 0.04, 0.9, C.woodLt);
              P('cylW', 0.5, 0, 0.6, 0.06, 0.5, 0.06, C.woodDk); P('sphere', 0.5, 0.42, 0.6, 0.18, 0.22, 0.18, C.hay);   // 巻藁
            }
            flag(0.9, 0.7, 1.7, c); flag(-0.9, 0.7, 1.7, c);
            break;
          case 'tower':
            pad(0, 0, 1.4, 1.4);
            shadow(0.9, 0.9);
            yagura(0, 0, 1.1, C.thatchDk);
            break;
        }
      }
      // ---- 兵士（足軽：鉄砲隊と槍隊）
      if (this.sprites) this.sprites.clear();
      if (cpx > 0.25) this.drawSoldiers(I, g, cpx, visible, col, C);
    }
    if (cpx > 1.4) this.addTrees(I, cpx);
    return I;
  },
  /**
   * 兵士の描画：起動時に描いた絵（スプライト）を、向き・動き・状態に合わせて選んで並べる。
   *   向き：5方向（正面・斜め前・横・斜め後ろ・背中）＋左右反転で8方向
   *   動き：歩き4コマ（進んだ距離で進める）・構え／攻撃（戦闘中）・倒れた姿（亡骸）
   *   引いているときは見つけやすいよう大きめに描く
   */
  drawSoldiers(I, g, cpx, visible, col, C) {
    const a = clamp(g.acc / CONFIG.TICK, 0, 1), t = this.clock;
    if (!this.anim) this.anim = new Map();
    if (!this.sprites) this.sprites = new SpriteList();
    const S = this.sprites;
    const anim = this.anim, idx = g.unitIndex;
    const seen = this.animSeen = (this.animSeen || 0) + 1;
    const H = clamp(this.cam.dist * 0.004, 0.96, 18), Wd = H * SPR.FW / SPR.FH;
    const AW = this.renderer.spriteSize ? this.renderer.spriteSize[0] : 2048, AH = this.renderer.spriteSize ? this.renderer.spriteSize[1] : 1024;
    const put = (x, z, yaw, kind, pose, c) => {
      let v = Math.round(Math.abs(yaw) / (Math.PI / 4));
      if (v > 4) v = 4;
      const k = SPR.index(kind, v, pose);
      let u0 = (k % SPR.COLS) * SPR.FW / AW, v0 = Math.floor(k / SPR.COLS) * SPR.FH / AH;
      let u1 = u0 + SPR.FW / AW;
      const v1 = v0 + SPR.FH / AH;
      if (yaw < 0) { const tmp = u0; u0 = u1; u1 = tmp; }   // 左向きは反転
      S.push(x, 0, z, Wd, H, u0, v0, u1, v1, c);
    };
    const P_IDLE = 0, P_WALK = 1, P_ATK = 5, P_DEAD = 7;
    for (const u of g.units) {
      const x = u.px + (u.x - u.px) * a, z = u.py + (u.y - u.py) * a;
      if (!visible(x, z)) continue;
      let s = anim.get(u.id);
      if (!s) { s = { phase: (u.id * 1.7) % 6.28, yaw: (u.id * 2.3) % 6.28 - 3.14, x, z }; anim.set(u.id, s); }
      const dx = x - s.x, dz = z - s.z, moved = Math.hypot(dx, dz);
      s.x = x; s.z = z; s.seen = seen;
      const e = u.engaged >= 0 && idx ? idx.get(u.engaged) : null;
      let target = s.yaw;
      if (e) target = Math.atan2(e.x - x, e.y - z);
      else if (moved > 1e-4) target = Math.atan2(dx, dz);
      const dy = ((target - s.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      s.yaw += dy * 0.3;
      if (s.yaw > Math.PI) s.yaw -= Math.PI * 2; else if (s.yaw < -Math.PI) s.yaw += Math.PI * 2;
      s.phase += moved * 6.5 / Math.max(1, H / 0.96);
      const gun = u.id % 3 !== 0, flag = u.id % 3 === 1;
      const kind = (gun ? 0 : 2) + (flag ? 1 : 0);
      let pose = P_IDLE;
      if (e || u.hitB) pose = P_ATK + ((((t + u.id * 0.37) * (gun ? 0.8 : 1.6)) % 1) < (gun ? 0.15 : 0.5) ? 1 : 0);
      else if (moved > 1e-4) pose = P_WALK + (Math.floor(s.phase / (Math.PI / 2)) & 3);
      I.shadow.push(x + 0.12 * H, 0.02, z - 0.14 * H, 0.55 * H, 0.01, 0.36 * H, [0, 0, 0], 0);
      put(x, z, s.yaw, kind, pose, col[u.pref]);
    }
    // 亡骸（倒れてからしばらく残る）
    if (this.corpses && this.corpses.length) {
      const keep = [];
      for (const c of this.corpses) {
        if (t - c.t > 8) continue;
        keep.push(c);
        if (visible(c.x, c.z)) put(c.x, c.z, c.yaw > 0 ? 1.6 : -1.6, c.kind || 0, P_DEAD, c.col);
      }
      this.corpses = keep;
    }
    if (seen % 300 === 0) for (const [id, s] of anim) if (seen - s.seen > 300) anim.delete(id);
  },
  /** 森のマスに木を並べる（場所から決まる乱数。高いところ・北は針葉樹、低いところは広葉樹） */
  addTrees(I, cpx) {
    const map = this.map, cam = this.cam, W = map.W, t = map.terrain, ew = map.elevW, ev = map.elev;
    const pts = [[0, 0], [this.w, 0], [0, this.h], [this.w, this.h]].map(([x, y]) => cam.groundAt(x, y)).filter(Boolean);
    if (pts.length < 4) return;
    const x0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.x)))), x1 = Math.min(W - 1, Math.ceil(Math.max(...pts.map((p) => p.x))));
    const y0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p.z)))), y1 = Math.min(map.H - 1, Math.ceil(Math.max(...pts.map((p) => p.z))));
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const step = Math.max(1, Math.ceil(Math.sqrt(area / 70000)));
    const s = clamp(cam.dist * 0.002, 0.55, 2.6) * 1.2;
    const v = [0, 0];
    const rich = cpx > 5;          // かなり拡大したら、木を段重ねにして立体的に
    const shadows = cpx > 3;
    let n = 0;
    for (let y = y0; y <= y1; y += step) {
      for (let x = x0; x <= x1; x += step) {
        const i = map.id(x, y);
        if (i < 0) continue;
        const k = t[i] & 7;
        if (k !== 2 && k !== 1) continue;
        const hk = ((x * 73856093) ^ (y * 19349663)) >>> 0;   // 場所から決まる乱数（細かい地図でも木がそろわないよう座標から）
        const h = ((hk * 2654435761) >>> 0) / 4294967296;
        if (k === 1 ? h > 0.01 : h > 0.5) continue;
        const h2 = ((hk * 40503 + 7) % 997) / 997, h3 = ((hk * 69069 + 3) % 991) / 991;
        const px = x + h2, pz = y + h3;
        if (!cam.project(px, 0, pz, v) || v[0] < -20 || v[0] > this.w + 20 || v[1] < -40 || v[1] > this.h + 20) continue;
        const sz = s * (0.8 + h2 * 0.5), snow = t[i] & 8;
        const es = map.elevScale, e = ev[Math.floor(y / es) * ew + Math.floor(x / es)];
        const conifer = snow || e > 120 || y < map.H * 0.3 || h3 > 0.75;
        if (shadows) I.shadow.push(px + sz * 0.35, 0.02, pz - sz * 0.4, sz * 0.9, 0.01, sz * 0.7, [0, 0, 0], 0);
        I.cylW.push(px, 0, pz, sz * 0.15, sz * 0.55, sz * 0.15, [0.36, 0.25, 0.15], 0);
        if (conifer) {
          const cc = snow ? [0.75, 0.82, 0.8] : [0.14 + h3 * 0.06, 0.34 + h2 * 0.1, 0.16];
          if (rich) {
            I.coneT.push(px, sz * 0.3, pz, sz * 1.05, sz * 0.8, sz * 1.05, cc, h2 * 6);
            I.coneT.push(px, sz * 0.75, pz, sz * 0.82, sz * 0.7, sz * 0.82, cc, h3 * 6);
            I.coneT.push(px, sz * 1.15, pz, sz * 0.55, sz * 0.65, sz * 0.55, cc, h2 * 3);
          } else I.coneT.push(px, sz * 0.35, pz, sz * 0.95, sz * 1.5, sz * 0.95, cc, 0);
        } else {
          const cc = [0.24 + h3 * 0.12, 0.44 + h2 * 0.12, 0.16];
          if (rich) {
            I.sphereT.push(px, sz * 0.4, pz, sz * 1.1, sz * 0.9, sz * 1.1, cc, 0);
            I.sphereT.push(px + sz * 0.3, sz * 0.75, pz - sz * 0.15, sz * 0.75, sz * 0.7, sz * 0.75, cc, 0);
            I.sphereT.push(px - sz * 0.28, sz * 0.7, pz + sz * 0.2, sz * 0.7, sz * 0.65, sz * 0.7, cc, 0);
          } else I.sphereT.push(px, sz * 0.35, pz, sz * 1.15, sz * 1.0, sz * 1.15, cc, 0);
        }
        if (++n >= CONFIG.TREE_MAX) return;
      }
    }
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
    // 煙突の煙（拡大時）
    if (this.smoke && this.smoke.length) {
      for (let k = 0; k < this.smoke.length; k++) {
        const [x, y, z] = this.smoke[k];
        for (let q = 0; q < 3; q++) {
          const ph = (this.clock * 0.35 + q / 3 + k * 0.137) % 1;
          if (!cam.project(x + ph * 0.8, y + ph * 2.2, z - ph * 0.3, v) || !onScreen()) continue;
          const r = (2 + ph * 7) * Math.min(2, cpx / 4);
          ctx.fillStyle = `rgba(215,212,205,${0.45 * (1 - ph)})`;
          ctx.beginPath(); ctx.arc(v[0], v[1], r, 0, Math.PI * 2); ctx.fill();
        }
      }
    }
    // 銃撃の閃光（兵士）と、塔・砦の射撃
    if (g && cpx > 0.5) {
      const a = clamp(g.acc / CONFIG.TICK, 0, 1);
      let n = 0;
      for (const u of g.units) {
        if (u.engaged < 0 && !u.hitB) continue;
        if (n > 500) break;
        const flick = ((u.id * 7 + Math.floor(this.clock * 9)) % 4) === 0;
        if (!flick) continue;
        if (!cam.project(u.px + (u.x - u.px) * a, cpx > 2.6 ? 0.35 : clamp(cam.dist * 0.0022, 0.6, 16) * 0.6, u.py + (u.y - u.py) * a, v) || !onScreen()) continue;
        const r = clamp(cpx * 0.5, 1.5, 4);
        ctx.fillStyle = 'rgba(255,214,120,.95)';
        ctx.beginPath(); ctx.arc(v[0] + 3, v[1], r, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,120,40,.45)';
        ctx.beginPath(); ctx.arc(v[0] + 3, v[1], r * 2.2, 0, Math.PI * 2); ctx.fill();
        n++;
      }
      if (g.shots && g.shots.length) {
        ctx.strokeStyle = 'rgba(255,170,90,.8)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (const [x0, y0, x1, y1] of g.shots) {
          if (!cam.project(x0, clamp(cam.dist * 0.0016, 0.9, 7) * 2, y0, v) || !onScreen() || !cam.project(x1, 0.5, y1, w)) continue;
          ctx.moveTo(v[0], v[1]); ctx.lineTo(w[0], w[1]);
        }
        ctx.stroke();
      }
    }
    // 攻撃を受けている建物の耐久ゲージ（拡大時、攻撃を受けてから3秒）
    if (g && cpx > 1.5) {
      for (const b of g.buildings) {
        if (b.hp >= b.maxHp || !(g.time - (b.hitAt || -99) < 3)) continue;
        if (!cam.project(b.x, clamp(cam.dist * 0.0016, 0.9, 7) * 2.4, b.y, v) || !onScreen()) continue;
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(v[0] - 12, v[1] - 6, 24, 4);
        ctx.fillStyle = b.hp / b.maxHp > 0.5 ? '#ffcf3f' : '#ff4a3d';
        ctx.fillRect(v[0] - 12, v[1] - 6, 24 * Math.max(0, b.hp) / b.maxHp, 4);
      }
    }
    // 拠点の名前と占領ゲージ
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    const fs = clamp(9 + Math.log2(cpx + 1) * 3, 9, 16);
    const bh = clamp(cam.dist * 0.0016, 0.9, 7) * 3.4;
    const placed = [];
    const order = [];
    if (g) {
      for (const n of g.nodes) if (n.type === 'capital' || cpx > 2.4 || (n.progress > 0 && cpx > 0.6) || n.id === g.rally) order.push(n);
    } else {
      for (let p = 1; p <= 47; p++) order.push({ type: 'capital', pref: p, owner: p, x: map.X(map.capitalCell[p]) + 0.5, y: map.Y(map.capitalCell[p]) + 0.5 });
    }
    const pri = this.state === STATE.TITLE ? this.titleSel : this.me;
    const score = (n) => (g && n.id === g.rally ? 2e6 : 0) + (n.pref === pri && n.type === 'capital' ? 1e6 : 0) + (n.type === 'capital' ? 1e4 + map.prefs[n.pref].pop : n.type === 'fort' ? 10 : 0);
    order.sort((p, q) => score(q) - score(p));
    for (const n of order) {
      if (!cam.project(n.x, n.type === 'capital' ? bh : bh * 0.6, n.y, v) || !onScreen()) continue;
      if (g && n.progress > 0) {
        const r = 11, f = n.progress / g.needFor(n);
        ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(0,0,0,.6)';
        ctx.beginPath(); ctx.arc(v[0], v[1] - r - 2, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = map.prefs[n.capBy].color; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(v[0], v[1] - r - 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * f); ctx.stroke();
      }
      const isCap = n.type === 'capital';
      let label = isCap ? map.prefs[n.pref].short + (cpx > 2 ? `（${map.prefs[n.pref].capName}）` : '') : n.name;
      if (g && n.id === g.rally) label = '⚔ ' + label;
      const size = isCap ? fs : clamp(fs - 3, 9, 12);
      ctx.font = `${isCap ? 700 : 600} ${size}px "Hiragino Mincho ProN","Yu Mincho",serif`;
      const tw = ctx.measureText(label).width;
      const ly = v[1] - (g && n.progress > 0 ? 26 : 2);
      const rect = [v[0] - tw / 2 - 2, ly - size - 2, v[0] + tw / 2 + 2, ly];
      if (placed.some((q) => q[0] < rect[2] && rect[0] < q[2] && q[1] < rect[3] && rect[1] < q[3])) continue;
      placed.push(rect);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,18,6,.85)';
      ctx.strokeText(label, v[0], ly);
      ctx.fillStyle = g && n.id === g.rally ? '#ff9b6b' : n.owner === n.pref ? '#fff5dc' : '#ffb3a8';
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
        const ax = map.X(l.a), ay = map.Y(l.a), bx = map.X(l.b), by = map.Y(l.b);
        if (!cam.project((ax + bx) / 2 + 0.5, 0, (ay + by) / 2 + 0.5, v)) continue;
        ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,18,6,.7)'; ctx.strokeText(l.name, v[0], v[1] - 4);
        ctx.fillStyle = '#ffe9a8'; ctx.fillText(l.name, v[0], v[1] - 4);
      }
    }
    ctx.font = '600 11px sans-serif';
    for (const s of this.renderer.linkStubs) {
      if (!cam.project(s.x, 0, s.y, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,18,6,.7)'; ctx.strokeText(s.name, v[0], v[1] - 3);
      ctx.fillStyle = '#ffe9a8'; ctx.fillText(s.name, v[0], v[1] - 3);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (const r of map.raw.insets) {
      if (!cam.project(r.poly[2] + 4, 0, r.poly[3] + 4, v)) continue;
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(30,18,6,.7)'; ctx.strokeText(r.label, v[0], v[1]);
      ctx.fillStyle = '#fff5dc'; ctx.fillText(r.label, v[0], v[1]);
    }
    // 選択中のもの
    if (this.sel) {
      const o = this.sel.n || this.sel.b;
      if (o && cam.project(o.x, 0, o.y, v)) {
        ctx.strokeStyle = '#ffe14d'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(v[0], v[1], 18, 9, 0, 0, Math.PI * 2); ctx.stroke();
      }
    }
    if (this.marker && this.clock - this.marker.t < 0.8) {
      const k = (this.clock - this.marker.t) / 0.8;
      if (cam.project(this.marker.x, 0, this.marker.z, v)) {
        ctx.strokeStyle = this.marker.ok ? `rgba(160,255,140,${1 - k})` : `rgba(255,90,70,${1 - k})`; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.ellipse(v[0], v[1], 8 + 20 * k, 4 + 10 * k, 0, 0, Math.PI * 2); ctx.stroke();
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
    const reach = Math.max(2.5, 16 / this.cam.cellPx());
    if (this.mode && this.mode.kind === 'place') {
      const type = this.mode.type;
      const r = g.playerBuild(type, i, p.x, p.z);
      this.marker = { x: p.x, z: p.z, t: this.clock, ok: r.ok };
      if (r.ok) {
        if (!g.canAfford(0, BUILDINGS[type].cost)) this.setMode(null);   // 資源が尽きたら建設モード終了
      } else this.showBuildFail(r.why);
      this.updateHud(true);
      return;
    }
    // 近くの拠点・建物
    let best = null, bd = reach;
    for (const n of g.nodes) { const d = Math.hypot(n.x - p.x, n.y - p.z); if (d < bd) { bd = d; best = { n }; } }
    g.buildingsNear(p.x, p.z, reach, (b, d) => { if (d < bd) { bd = d; best = { b }; } });
    if (this.mode && this.mode.kind === 'rally') {
      if (best && best.n) {
        if (best.n.owner === this.me) { g.setRally(-1); this.banner('攻撃目標を解除', 'def', '兵士は県の作戦に従います'); }
        else { g.setRally(best.n.id); this.banner('攻撃目標を指定！', 'ok', `あなたの兵士が ${best.n.name} へ向かいます`); }
        this.setMode(null);
        this.updateHud(true);
      } else this.banner('拠点をタップしてください', 'ng', '県庁・町・砦が目標になります');
      return;
    }
    if (best) this.select(best); else this.hidePanel();
  },
  showBuildFail(why) {
    const msg = { sea: '海には建てられません', notown: '自県の領土の中に建ててください', crowded: 'ほかの建物に近すぎます',
      nearnode: `町・砦はほかの拠点から${CONFIG.NODE_MIN_DIST * (this.map.scale || 1)}マス以上離してください`, terrain: '農場は山には建てられません',
      noforest: '製材所は森の近くに建ててください', cost: '資源が足りません' }[why] || '建てられません';
    this.banner('建設できません', 'ng', msg);
  },
  frame(now) {
    const dt = Math.min(0.1, Math.max(0, (now - this.lastT) / 1000));
    this.lastT = now;
    this.clock += dt;
    if (this.renderer && !this.glLost) {
      this.keyPan(dt);
      this.cam.update(dt);
      if (this.state === STATE.PLAYING && this.game && !this.paused) {
        this.game.update(dt, this.speed);
        this.updateHud(false);
      }
      const mixT = clamp((this.cam.pitch - CONFIG.CAMERA_PITCH) / (CONFIG.TOP_PITCH - CONFIG.CAMERA_PITCH), 0, 1);
      this.renderer.render(this.cam, {
        fill: CONFIG.FILL + (CONFIG.FILL_TOP - CONFIG.FILL) * mixT,
        place: this.state === STATE.PLAYING && this.mode && this.mode.kind === 'place',
        time: this.clock, meshes: this.buildScene(), sprites: this.state === STATE.PLAYING || this.state === STATE.GAMEOVER ? this.sprites : null,
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
            const ci = map.id(cx, cy);
            o = ci >= 0 ? own[ci] : 0;
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
    const rn = g && g.rally >= 0 ? g.nodes[g.rally] : null;   // 攻撃目標
    if (rn) {
      ctx.fillStyle = '#ff6b3d'; ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(rn.x / map.W * mw, rn.y / map.H * mh, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
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
      else if (this.mode) this.setMode(null);
      else this.hidePanel();
    }
    if (this.state !== STATE.PLAYING || this.paused) return;
    if (k === 't' || k === 'T') this.toggleTop();
    else if (k === 'h' || k === 'H') this.goHome();
    else if (k === 'r' || k === 'R') this.toggleRallyMode();
    else if (k >= '1' && k <= '7') this.startPlace(BUILD_ORDER[+k - 1]);
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
    return this.map.id(x, y);
  },
  restoreGL() {
    try {
      this.renderer = new Renderer($('gl'), this.map);
      this.renderer.setPalette(this.map.paletteColors());
      this.renderer.uploadTerrain();
      if (!this.painter) this.painter = new SoldierPainter().paint();   // 兵士の絵を描く（初回だけ）
      this.renderer.uploadSprites(this.painter);
      if (!this.groundPainter) this.groundPainter = new GroundPainter().paint();   // 草の筋の絵
      this.renderer.uploadGround(this.groundPainter);
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
