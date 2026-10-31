// Playwright による自動テスト（RTS版）
//   python3 tools/build.py && node tests/run_tests.js
//   MINUTES=20 node tests/run_tests.js   （長時間テストのゲーム内分数を変更）
// スクリーンショットは test-results/ に保存される。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html') + '?seed=12345';
const OUT = path.join(ROOT, 'test-results');
const MINUTES = +(process.env.MINUTES || 10);
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  /** ゲーム内時間を sec 秒ぶん即座に進める（描画とは無関係に Sim.step を回す） */
  const advance = (sec) => ev((sec) => { const g = window.__jinchi.game; for (let k = 0; k < Math.round(sec / 0.1); k++) g.step(0.1); }, sec);
  /** ワールド座標(x,z)をカメラに収めて、その画面座標を返す */
  const toScreen = (x, z, dist = 60) => ev(({ x, z, dist }) => {
    const { App } = window.__jinchi;
    App.cam.goal = null; App.cam.pitch = App.cam.pitchGoal; App.cam.tx = x; App.cam.tz = z; App.cam.dist = dist; App.cam.compute();
    const v = [0, 0]; App.cam.project(x, 0, z, v); return v;
  }, { x, z, dist });
  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      passed++; console.log(`  ✔ ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++; console.log(`  ✘ ${name}\n      ${e.message.split('\n')[0]}`);
      await shot('FAIL_' + name.replace(/[^\w]+/g, '_')).catch(() => {});
    }
  }

  await test('読み込み → TITLE 状態になる', async () => {
    const t0 = Date.now();
    await page.goto(URL);
    await page.waitForFunction(() => (window.__jinchi && window.__jinchi.App.state === 'TITLE') || window.__jinchiError, null, { timeout: 60000 });
    assert(!(await ev(() => window.__jinchiError || null)), 'load error');
    console.log(`      load ${Date.now() - t0}ms`);
    const info = await ev(() => {
      const m = window.__jinchi.App.map;
      return { W: m.W, H: m.H, land: m.landCells, prefs: m.prefs.filter(Boolean).length, de: m.raw.minNeighborDeltaE,
        towns: m.raw.towns.length, src: document.querySelector('.credit').textContent };
    });
    assert(info.W === 2400 && info.H === 2510, 'grid size');
    assert(info.land > 550000 && info.land < 680000, 'land cells ' + info.land);
    assert(info.prefs === 47 && info.de >= 70, 'prefs / deltaE');
    assert(info.towns > 400, 'towns ' + info.towns);
    assert(info.src.includes('地球地図日本（国土地理院）'), '出典表示');
    await page.waitForTimeout(800);
    await shot('01_title');
  });

  await test('タイトル: 地図タップで県を選べる', async () => {
    const hok = await ev(() => window.__jinchi.App.map.capitalCell[1]);
    const v = await ev((c) => { const { App } = window.__jinchi; const W = App.map.W; App.cam.compute(); const v = [0, 0]; return App.cam.project(c % W + 0.5, 0, ((c / W) | 0) + 0.5, v); }, hok);
    await page.mouse.click(v[0], v[1]);
    assert((await ev(() => window.__jinchi.App.titleSel)) === 1, 'titleSel');
  });

  await test('出陣 → 約1000部隊・560拠点、自分の部隊が県庁の近くにいる', async () => {
    await page.click('.pbtn[data-p="20"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const s = await ev(() => {
      const g = window.__jinchi.game, cap = g.nodes[g.me - 1], u = g.player;
      return { units: g.units.length, nodes: g.nodes.length, mine: g.units.filter((q) => q.pref === g.me).length,
        tottori: g.units.filter((q) => q.pref === 31).length, d: Math.hypot(u.x - cap.x, u.y - cap.y), alive: u.alive,
        pref: document.getElementById('h-pref').textContent };
    });
    assert(s.units > 950 && s.units < 1100, 'units ' + s.units);
    assert(s.nodes > 500, 'nodes ' + s.nodes);
    assert(s.mine === Math.max(3, Math.round(204.8 / 100 * 8)) && s.tottori === Math.max(3, Math.round(55.3 / 100 * 8)), 'participants');
    assert(s.alive && s.d < 25 && s.pref === '長野県', JSON.stringify(s));
    await page.waitForTimeout(1200);
    await shot('02_playing');
  });

  await test('沖縄: 左下のインセットにあり、航路で鹿児島とつながる', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, m = g.map, W = m.W;
      const cap = m.capitalCell[47], kago = m.capitalCell[46], hok = m.capitalCell[1];
      const okNodes = g.nodes.filter((n) => n.pref === 47).map((n) => n.id);
      const adjPrefs = new Set();
      for (const id of okNodes) for (const a of g.nodeAdj[id]) if (g.nodes[a].pref !== 47) adjPrefs.add(g.nodes[a].pref);
      const path = g.nav.find((kago % W) + 0.5, ((kago / W) | 0) + 0.5, (cap % W) + 0.5, ((cap / W) | 0) + 0.5);
      const ll = m.lonLat(cap % W, (cap / W) | 0);
      return { capY: (cap / W) | 0, kagoY: (kago / W) | 0, capX: cap % W, hokX: hok % W, adj: [...adjPrefs], path: path ? path.length : -1, ll };
    });
    assert(r.capY > r.kagoY && r.capX < r.hokX - 800, '配置 ' + JSON.stringify(r));
    assert(r.adj.length >= 1 && r.adj.every((p) => p === 46), '隣接は鹿児島のみ ' + r.adj);
    assert(r.path > 0, '鹿児島から那覇へ経路がある');
    assert(Math.abs(r.ll[0] - 127.68) < 0.05 && Math.abs(r.ll[1] - 26.21) < 0.05, '経緯度 ' + r.ll);
  });

  await test('地図をタップ → 自分の部隊がそこへ向かう', async () => {
    const u0 = await ev(() => { const u = window.__jinchi.game.player; return [u.x, u.y]; });
    const tx = u0[0] + 25, tz = u0[1] + 10;
    const v = await toScreen(tx, tz, 90);
    await page.mouse.click(v[0], v[1]);
    const st = await ev(() => { const u = window.__jinchi.game.player; return { dest: u.dest, text: document.getElementById('u-status').textContent }; });
    assert(st.dest && Math.hypot(st.dest[0] - tx, st.dest[1] - tz) < 2, 'dest ' + JSON.stringify(st));
    const d0 = Math.hypot(u0[0] - tx, u0[1] - tz);
    await advance(3);
    const u1 = await ev(() => { const u = window.__jinchi.game.player; return [u.x, u.y]; });
    const d1 = Math.hypot(u1[0] - tx, u1[1] - tz);
    assert(d1 < d0 - 8, `近づいた ${d0.toFixed(1)} → ${d1.toFixed(1)}`);
    await page.waitForTimeout(300);
    await shot('03_move');
  });

  await test('海をタップすると移動しない', async () => {
    const sea = await ev(() => { const m = window.__jinchi.App.map; const u = window.__jinchi.game.player; window.__jinchi.game.player.dest = null; for (let x = u.x | 0; x > 0; x--) { const i = (u.y | 0) * m.W + x; if (!m.initPref[i]) return [x + 0.5 - 30, u.y]; } return [5, 5]; });
    const v = await toScreen(sea[0], sea[1], 120);
    await page.mouse.click(v[0], v[1]);
    const st = await ev(() => ({ dest: window.__jinchi.game.player.dest, banner: document.getElementById('banner').textContent }));
    assert(!st.dest && st.banner.includes('海'), JSON.stringify(st));
  });

  await test('拠点をタップすると情報パネルが出る', async () => {
    const n = await ev(() => { const g = window.__jinchi.game; const n = g.nodes[g.me - 1]; return [n.x, n.y, n.name]; });
    const v = await toScreen(n[0], n[1], 80);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    assert((await page.textContent('#cp-name')) === n[2], 'node name');
    assert((await page.textContent('#cp-owner')).includes('長野県'), 'owner');
    await page.click('#cp-close');
  });

  await test('戦闘: 敵の部隊と近づくと自動で戦いHPが減る', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, u = g.player;
      const e = g.units.find((q) => q.pref !== g.me && q.alive);
      // 周りのほかの部隊はどけて、1対1にする
      for (const q of g.units) if (q !== u && q !== e && Math.hypot(q.x - u.x, q.y - u.y) < 15) { q.x = q.px = q.x + 100; }
      e.path = null; e.dest = null; e.chase = -1; e.thinkAt = 1e9; u.dest = null;
      u.hp = 100; e.hp = 100;
      let engagedSeen = false;
      for (let k = 0; k < 20; k++) { e.x = e.px = u.x + 1.2; e.y = e.py = u.y; g.step(0.1); if (u.engaged === e.id && e.engaged === u.id) engagedSeen = true; }
      e.thinkAt = 0;
      return { uhp: u.hp, ehp: e.hp, engaged: engagedSeen };
    });
    assert(r.uhp < 100 && r.ehp < 100 && r.engaged, JSON.stringify(r));
  });

  await test('占領: 敵の拠点に部隊で居座ると占領でき、周りの領土が自県になる', async () => {
    const r = await ev(() => {
      const J = window.__jinchi, g = J.game, me = g.me;
      // 自県に隣接する敵の町
      let target = null;
      for (const n of g.nodes) if (n.owner === me) for (const a of g.nodeAdj[n.id]) { const e = g.nodes[a]; if (e.owner !== me && e.type === 'town') { target = e; break; } }
      const before = { owner: target.owner, mine: g.counts[me], cells: g.nodeCells[target.id].length };
      // 周りの敵部隊をどけて、自分と味方を集める
      for (const q of g.units) {
        const d = Math.hypot(q.x - target.x, q.y - target.y);
        if (q.pref !== me && d < 20) { q.x = q.px = q.x + 200; }
      }
      const team = g.units.filter((q) => q.pref === me && q.alive).slice(0, 6);
      for (const q of team) { q.x = q.px = target.x + (Math.random() - 0.5) * 3; q.y = q.py = target.y + (Math.random() - 0.5) * 3; q.dest = null; q.path = null; q.thinkAt = 1e9; q.hp = 100; }
      let t = 0;
      // 守備に戻ってくる敵部隊も毎回どける（テストでは占領の仕組みだけを確かめる）
      while (target.owner !== me && t < 300) {
        for (const q of g.units) if (q.pref !== me && q.alive && Math.hypot(q.x - target.x, q.y - target.y) < 15) { q.x = q.px = q.x + 200; }
        g.step(0.1); t++;
        for (const q of team) if (q.alive) { q.x = target.x; q.y = target.y; }
      }
      for (const q of team) q.thinkAt = 0;
      const owners = new Set(); for (const i of g.nodeCells[target.id]) owners.add(g.owner[i]);
      return { name: target.name, steps: t, owner: target.owner, me, before, after: g.counts[me], owners: [...owners] };
    });
    assert(r.owner === r.me, '占領できていない ' + JSON.stringify(r));
    assert(r.after > r.before.mine && r.owners.length === 1 && r.owners[0] === r.me, '領土 ' + JSON.stringify(r));
    await page.waitForTimeout(200);
    const log = await page.textContent('#log');
    assert(log.includes('占領しました'), 'log ' + log);
    await shot('04_capture');
  });

  await test('砦: 自県の領土で砦を建てると国境が押し出される', async () => {
    const r = await ev(() => {
      const J = window.__jinchi, g = J.game, me = g.me, W = g.map.W;
      g.gold[me] = 5000;
      // 自県の領土で、拠点から十分離れていて、他県に近いマスを探す
      let site = -1;
      for (const n of g.nodes) {
        if (n.owner !== me) continue;
        for (const a of g.nodeAdj[n.id]) {
          const e = g.nodes[a]; if (e.owner === me) continue;
          for (const f of [0.5, 0.4, 0.6, 0.3]) {
            const c = g.cellAt(n.x + (e.x - n.x) * f, n.y + (e.y - n.y) * f);
            if (!g.canBuildFort(me, c)) { site = c; break; }
          }
          if (site >= 0) break;
        }
        if (site >= 0) break;
      }
      const u = g.player; u.alive = true; u.hp = 100;
      u.x = u.px = (site % W) + 0.5; u.y = u.py = ((site / W) | 0) + 0.5; u.dest = null;
      window.__fort0 = { nodes: g.nodes.length, gold: g.gold[me], cells: g.counts[me] };
      J.App.updateHud(true);
      return site;
    });
    assert(r >= 0, 'site');
    assert(!(await page.isDisabled('#btn-fort')), 'fort button enabled');
    await page.click('#btn-fort');
    const s = await ev(() => { const g = window.__jinchi.game, me = g.me; const n = g.nodes[g.nodes.length - 1]; return { ...window.__fort0, n2: g.nodes.length, gold2: g.gold[me], cells2: g.counts[me], type: n.type, owner: n.owner, me }; });
    assert(s.n2 === s.nodes + 1 && s.type === 'fort' && s.owner === s.me, JSON.stringify(s));
    // ボタンを押すまでの間にも収入が入るので、建設費400億から少し小さくてもよい
    assert(s.gold - s.gold2 >= 330 && s.cells2 >= s.cells, 'cost/cells ' + JSON.stringify(s));
    assert((await page.textContent('#banner')).includes('砦'), 'banner');
    await page.waitForTimeout(300);
    await shot('05_fort');
  });

  await test('倒されると近くの自県の拠点で復活する', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, u = g.player;
      g.kill(u);
      const dead = !u.alive;
      for (let k = 0; k < 90; k++) g.step(0.1);
      let near = 1e9; for (const n of g.nodes) if (n.owner === g.me) near = Math.min(near, Math.hypot(n.x - u.x, n.y - u.y));
      return { dead, alive: u.alive, hp: u.hp, near };
    });
    assert(r.dead && r.alive && r.hp === 100 && r.near < 5, JSON.stringify(r));
  });

  await test('おまかせ: ONにするとAIと同じように自分の部隊が動く', async () => {
    await page.click('#btn-auto');
    assert((await ev(() => window.__jinchi.game.auto)) === true, 'auto on');
    assert((await page.textContent('#btn-auto')).includes('ON'), 'label');
    await advance(6);
    const r = await ev(() => { const u = window.__jinchi.game.player; return { dest: !!u.dest, goal: u.goalNode, chase: u.chase }; });
    assert(r.dest || r.goal >= 0 || r.chase >= 0, JSON.stringify(r));
    await page.click('#btn-auto');
    assert((await ev(() => window.__jinchi.game.auto)) === false, 'auto off');
  });

  await test('真上ビューと戻る', async () => {
    await page.click('[data-act=top]');
    await page.waitForTimeout(900);
    assert(Math.abs((await ev(() => window.__jinchi.App.cam.pitch)) - 90) < 0.5, 'top');
    await ev(() => { window.__jinchi.App.cam.dist = 900; });
    await page.waitForTimeout(400);
    await shot('06_topview');
    await page.click('[data-act=top]');
    await page.waitForTimeout(900);
    assert(Math.abs((await ev(() => window.__jinchi.App.cam.pitch)) - 55) < 0.5, 'tilt');
  });

  await test('カメラ: ドラッグ移動・ホイール拡大縮小・キーボード・ミニマップ・自県へ・部隊へ', async () => {
    await ev(() => { const c = window.__jinchi.App.cam; c.goal = null; c.dist = 300; });
    const c0 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    await page.mouse.move(200, 500); await page.mouse.down(); await page.mouse.move(260, 560, { steps: 5 }); await page.mouse.up();
    const c1 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    assert(c1[0] < c0[0] && c1[1] < c0[1], 'drag pans');
    // ドラッグはタップ扱いにならない（移動命令は出ない）
    for (let k = 0; k < 20; k++) await page.mouse.wheel(0, 2000);
    assert((await ev(() => window.__jinchi.App.cam.dist)) === (await ev(() => window.__jinchi.CONFIG.ZOOM_MAX)), 'zoom max');
    for (let k = 0; k < 40; k++) await page.mouse.wheel(0, -2000);
    assert((await ev(() => window.__jinchi.App.cam.dist)) === 5, 'zoom min');
    await page.waitForTimeout(200);
    await shot('07_zoom_min');
    await page.keyboard.press('Minus');
    assert((await ev(() => window.__jinchi.App.cam.dist)) > 5, 'key zoom');
    const box = await page.locator('#minimap').boundingBox();
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.15);
    const goal = await ev(() => window.__jinchi.App.cam.goal);
    assert(goal && goal.x > 1700, 'minimap ' + JSON.stringify(goal));
    await page.waitForTimeout(800);
    await page.click('#btn-unit');
    await page.waitForTimeout(900);
    const du = await ev(() => { const { App } = window.__jinchi, u = App.game.player; return Math.hypot(App.cam.tx - u.x, App.cam.tz - u.y); });
    assert(du < 150, 'unit focus ' + du);
  });

  await test('タッチ: 2本指ピンチで拡大縮小・1本指ドラッグで移動', async () => {
    const cdp = await page.context().newCDPSession(page);
    await ev(() => { const c = window.__jinchi.App.cam; c.goal = null; c.dist = 400; });
    const tp = (pts) => pts.map(([x, y], id) => ({ x, y, id }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[150, 420], [240, 420]]) });
    for (let k = 1; k <= 6; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[150 - k * 15, 420], [240 + k * 15, 420]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert((await ev(() => window.__jinchi.App.cam.dist)) < 280, 'pinch');
    const t0 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[200, 420]]) });
    for (let k = 1; k <= 5; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[200 + k * 12, 420 + k * 12]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const t1 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    assert(t1[0] < t0[0] && t1[1] < t0[1], 'touch drag');
    await cdp.detach();
  });

  await test('戦況ボタン：47県の順位', async () => {
    await page.click('[data-act=rank]');
    await page.waitForSelector('#modal:not(.hidden)');
    assert((await page.$$('#m-body .rank-row')).length === 47, '47 rows');
    await shot('08_ranking');
    await page.click('#m-btns button');
    assert(await page.isHidden('#modal'), 'closed');
  });

  await test(`${MINUTES}分間進めてもエラーなし・整合性OK`, async () => {
    const r = await ev((min) => {
      const g = window.__jinchi.game, m = g.map;
      const t = performance.now();
      const steps = min * 600;
      let worst = 0;
      for (let k = 0; k < steps && !g.over; k++) { const s = performance.now(); g.step(0.1); worst = Math.max(worst, performance.now() - s); }
      const ms = performance.now() - t;
      // 整合性
      let sum = 0; for (let p = 1; p <= 47; p++) sum += g.counts[p];
      const cnt = new Int32Array(49), nc = new Int32Array(49);
      let badOwner = 0, badPos = 0;
      for (const i of g.landIdx) { cnt[g.owner[i]]++; if (g.owner[i] !== g.nodes[g.nodeOf[i]].owner) badOwner++; }
      for (const n of g.nodes) nc[n.owner]++;
      let badCnt = 0; for (let p = 1; p <= 47; p++) { if (cnt[p] !== g.counts[p]) badCnt++; if (nc[p] !== g.nodeCount[p]) badCnt++; }
      for (const u of g.units) if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || u.x < 0 || u.y < 0 || u.x > m.W || u.y > m.H) badPos++;
      return { sum, land: m.landCells, badOwner, badCnt, badPos, ms: Math.round(ms), perStep: +(ms / steps).toFixed(2), worst: +worst.toFixed(1),
        stats: g.stats, time: Math.round(g.time), elim: g.eliminated.size, over: g.over, nodes: g.nodes.length };
    }, MINUTES);
    console.log(`      ${JSON.stringify(r)}`);
    assert(r.sum === r.land, 'sum');
    assert(!r.badOwner && !r.badCnt && !r.badPos, 'consistency ' + JSON.stringify(r));
    assert(r.stats.captures > 50 && r.stats.kills > 100, 'activity');
    assert(r.perStep < 15 && r.worst < 40, 'performance ' + r.perStep + ' worst ' + r.worst);
    await ev(() => { const { App } = window.__jinchi; App.cam.goal = null; App.cam.dist = 2600; App.updateHud(true); });
    await page.waitForTimeout(600);
    await shot('09_after_minutes');
  });

  await test('脱落: 全ての拠点を失った県は脱落し、部隊も復活しない', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, victim = g.me === 31 ? 30 : 31, by = victim === 31 ? 32 : 29;
      for (const n of g.nodes) if (n.owner === victim) g.capture(n, by);
      const units = g.units.filter((u) => u.pref === victim);
      for (let k = 0; k < 100; k++) g.step(0.1);
      return { elim: g.eliminated.has(victim), nodes: g.nodeCount[victim], cells: g.counts[victim], alive: units.filter((u) => u.alive).length,
        log: [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('脱落')) };
    });
    assert(r.elim && r.nodes === 0 && r.cells === 0 && r.alive === 0 && r.log, JSON.stringify(r));
  });

  await test('勝利: 全国の規定割合を支配すると GAMEOVER（勝利）', async () => {
    await ev(() => { const J = window.__jinchi, g = J.game; J.CONFIG.WIN_RATIO = (g.counts[g.me] - 0.5) / g.map.landCells; g.checkEnd(); });
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    assert((await page.textContent('#m-body')).includes('天下統一'), 'win text');
    await shot('10_win');
    await ev(() => { window.__jinchi.CONFIG.WIN_RATIO = 0.5; });
    await page.click('#m-btns button');
    await page.waitForFunction(() => window.__jinchi.App.state === 'TITLE');
  });

  await test('敗北: 自県の拠点が0になると GAMEOVER（敗北）→ タイトル → 再スタートで片付いている', async () => {
    await page.click('.pbtn[data-p="31"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    await ev(() => { window.__oldGame = window.__jinchi.game; const g = window.__jinchi.game; for (const n of g.nodes) if (n.owner === g.me) g.capture(n, 32); });
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    assert((await page.textContent('#m-body')).includes('敗北'), 'lose text');
    await shot('11_lose');
    await page.click('#m-btns button');
    await page.waitForFunction(() => window.__jinchi.App.state === 'TITLE');
    const c = await ev(() => ({ l: Object.keys(window.__oldGame.listeners).length, g: window.__jinchi.game, hud: document.getElementById('hud').classList.contains('hidden') }));
    assert(c.l === 0 && c.g === null && c.hud, 'disposed ' + JSON.stringify(c));
    await page.click('.pbtn[data-p="47"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const s = await ev(() => { const g = window.__jinchi.game; return { t: g.time, cells: g.counts[47], init: g.map.initCounts[47], logs: document.getElementById('log').children.length }; });
    assert(s.t < 2 && s.cells === s.init && s.logs <= 2, 'fresh ' + JSON.stringify(s));
    await page.waitForTimeout(1500);
    await shot('12_okinawa');
  });

  await test('WebGLコンテキストを失っても復帰して描画を続ける', async () => {
    const r = await ev(async () => {
      const { App } = window.__jinchi;
      const ext = App.renderer.gl.getExtension('WEBGL_lose_context');
      if (!ext) return { skip: true };
      ext.loseContext();
      await new Promise((r) => setTimeout(r, 300));
      const lost = App.glLost;
      ext.restoreContext();
      await new Promise((r) => setTimeout(r, 1500));
      return { lost, after: App.glLost, err: window.__jinchiError || null };
    });
    if (r.skip) { console.log('      (WEBGL_lose_context なし: スキップ)'); return; }
    assert(r.lost === true && r.after === false && !r.err, JSON.stringify(r));
  });

  await test('画面サイズ変更（横向き・PC幅・小さい画面）でも崩れない', async () => {
    for (const vp of [{ width: 844, height: 390 }, { width: 1280, height: 800 }, { width: 360, height: 640 }]) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(300);
      const r = await ev(() => ({ cw: document.getElementById('gl').width, w: innerWidth, sx: document.documentElement.scrollWidth }));
      assert(r.cw > 0 && r.sx <= r.w, JSON.stringify(r));
    }
    await shot('13_small_screen');
    await page.setViewportSize({ width: 390, height: 844 });
  });

  await test('コンソールエラーなし', async () => {
    assert(errors.length === 0, errors.join('\n'));
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
