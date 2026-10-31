// Playwright による自動テスト
//   node tests/run_tests.js            （index.html を事前に tools/build.py で生成しておく）
//   DAYS=60 node tests/run_tests.js    （長期テストの日数を変更）
// スクリーンショットは test-results/ に保存される。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html') + '?seed=12345';
const OUT = path.join(ROOT, 'test-results');
const DAYS = +(process.env.DAYS || 40);
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
const results = [];
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  /** マスの画面座標（カメラをそのマスへ寄せてから） */
  async function cellToScreen(cell, dist = 40) {
    return ev(({ cell, dist }) => {
      const { App } = window.__jinchi; const W = App.map.W;
      App.cam.goal = null; App.cam.pitch = App.cam.pitchGoal;
      App.cam.tx = cell % W + 0.5; App.cam.tz = ((cell / W) | 0) + 0.5; App.cam.dist = dist;
      App.cam.compute();
      const v = [0, 0];
      App.cam.project(cell % W + 0.5, 0, ((cell / W) | 0) + 0.5, v);
      return v;
    }, { cell, dist });
  }
  /** 自県に隣接していて攻撃できるマスを1つ探す */
  const findAttackable = () => ev(() => {
    const g = window.__jinchi.game; const fr = g.frontier[g.me];
    for (let k = 0; k < fr.length; k++) {
      const f = fr[(k * 7919) % fr.length]; let t = -1;
      g.forNeighbors(f, (j) => { if (t < 0 && g.owner[j] !== g.me && !g.canAttack(g.me, j) && !g.map.linkMap.has(j)) t = j; });
      if (t >= 0) return t;
    }
    return -1;
  });
  async function test(name, fn) {
    const t0 = Date.now();
    try {
      await fn();
      passed++; results.push(`  ✔ ${name} (${Date.now() - t0}ms)`);
    } catch (e) {
      failed++; results.push(`  ✘ ${name}\n      ${e.message}`);
      await shot('FAIL_' + name.replace(/[^\w]+/g, '_')).catch(() => {});
    }
    console.log(results[results.length - 1]);
  }

  await test('読み込み → TITLE 状態になる', async () => {
    const t0 = Date.now();
    await page.goto(URL);
    await page.waitForFunction(() => (window.__jinchi && window.__jinchi.App.state === 'TITLE') || window.__jinchiError, null, { timeout: 60000 });
    const err = await ev(() => window.__jinchiError || null);
    assert(!err, 'load error ' + err);
    console.log(`      load ${Date.now() - t0}ms`);
    const info = await ev(() => {
      const m = window.__jinchi.App.map;
      return { W: m.W, H: m.H, land: m.landCells, prefs: m.prefs.filter(Boolean).length, de: m.raw.minNeighborDeltaE,
        links: m.raw.links.length, src: document.querySelector('.credit').textContent };
    });
    assert(info.W === 2400 && info.H === 2160, 'grid size');
    assert(info.land > 550000 && info.land < 680000, 'land cells ' + info.land);
    assert(info.prefs === 47, 'prefs');
    assert(info.de >= 70, 'min neighbor deltaE ' + info.de);
    assert(info.src.includes('地球地図日本（国土地理院）'), '出典表示');
    await page.waitForTimeout(800);
    await shot('01_title');
  });

  await test('タイトル: 地図タップで県を選べる', async () => {
    const hok = await ev(() => window.__jinchi.App.map.capitalCell[1]);
    const v = await ev((c) => { const { App } = window.__jinchi; const W = App.map.W; App.cam.compute(); const v = [0, 0]; return App.cam.project(c % W + 0.5, 0, ((c / W) | 0) + 0.5, v); }, hok);
    await page.mouse.click(v[0], v[1]);
    const sel = await ev(() => window.__jinchi.App.titleSel);
    assert(sel === 1, 'titleSel=' + sel);
    assert(await page.isEnabled('#btn-start'), 'start enabled');
  });

  await test('タイトル: 県ボタンで選んで出陣 → PLAYING', async () => {
    await page.click('.pbtn[data-p="20"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    assert((await page.textContent('#h-pref')) === '長野県', 'HUD pref');
    const n = await ev(() => window.__jinchi.game.participants.filter((p) => p.pref === 20).length);
    assert(n === Math.max(3, Math.round(204.8 / 100 * 6)), 'participants ' + n);
    const tottori = await ev(() => window.__jinchi.game.participants.filter((p) => p.pref === 31).length);
    assert(tottori === 3, 'min participants');
    await page.waitForTimeout(1500);
    await shot('02_playing');
  });

  await test('隣接していないマスは攻撃できない（行動は消費しない）', async () => {
    const far = await ev(() => window.__jinchi.App.map.capitalCell[1]); // 北海道庁
    const v = await cellToScreen(far, 60);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    assert(await page.isDisabled('#cp-action'), 'button should be disabled');
    assert((await page.textContent('#cp-action')).includes('隣接していません'), 'reason text');
    const acted = await ev(() => window.__jinchi.game.player.acted);
    assert(!acted, 'not consumed');
    await page.click('#cp-close');
  });

  await test('攻撃: マスをタップ →「今すぐ攻撃する」→ 制圧', async () => {
    await ev(() => { window.__jinchi.CONFIG.ATTACK_SUCCESS = 1; });
    const t = await findAttackable();
    assert(t >= 0, 'attackable cell');
    const before = await ev((t) => window.__jinchi.game.owner[t], t);
    const v = await cellToScreen(t, 40);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    const label = await page.textContent('#cp-action');
    assert(label.includes('今すぐ攻撃する'), 'label ' + label);
    await shot('03_cell_panel');
    await page.click('#cp-action');
    const st = await ev((t) => { const g = window.__jinchi.game; return { owner: g.owner[t], changed: g.dayChanged[t] === g.day, acted: g.player.acted, me: g.me }; }, t);
    assert(st.owner === st.me && st.owner !== before, 'owner changed');
    assert(st.changed && st.acted, 'flags');
    assert((await page.textContent('#banner')).includes('制圧成功'), 'banner');
    assert((await page.textContent('#soldier')).includes('完了'), 'soldier status');
    // 同じ日にもう一度は行動できない
    assert(await page.isDisabled('#cp-action'), 'second action blocked');
    // 当日変わったマスは他県も奪えない
    const why = await ev((t) => { const g = window.__jinchi.game; for (let p = 1; p <= 47; p++) if (p !== g.me && g.adjacentTo(t, p)) return g.attack(p, t, false).why; return 'changed'; }, t);
    assert(why === 'changed', 'once per day: ' + why);
    await ev(() => { window.__jinchi.CONFIG.ATTACK_SUCCESS = 0.85; });
    await page.waitForTimeout(300);
    await shot('04_attacked');
    await page.click('#cp-close');
  });

  await test('次の日へ → 日報 → DAY 2', async () => {
    await page.click('#btn-next');
    await page.waitForSelector('#modal:not(.hidden)');
    const title = await page.textContent('#m-title');
    assert(title.includes('日報 DAY 1'), title);
    const body = await page.textContent('#m-body');
    assert(body.includes('制圧成功') && body.includes('今日の制圧') && body.includes('活躍した県'), 'report body');
    await shot('05_report');
    await page.click('#m-btns button');
    const st = await ev(() => { const g = window.__jinchi.game; return { day: g.day, acted: g.player.acted, t: g.time, paused: window.__jinchi.App.paused }; });
    assert(st.day === 2 && !st.acted && st.t < 1 && !st.paused, JSON.stringify(st));
    assert((await page.textContent('#h-day')) === 'DAY 2', 'HUD day');
  });

  await test('防御: 自県の県境マスを防御 → その日は絶対に取られない', async () => {
    const f = await ev(() => { const g = window.__jinchi.game; const fr = g.frontier[g.me]; return fr.find((i) => !g.map.linkMap.has(i) && g.defendedDay[i] !== g.day && g.dayChanged[i] !== g.day); });
    const v = await cellToScreen(f, 40);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    assert((await page.textContent('#cp-action')).includes('今すぐ防御する'), 'defend label');
    await page.click('#cp-action');
    const r = await ev((f) => {
      const g = window.__jinchi.game; window.__jinchi.CONFIG.ATTACK_SUCCESS = 1;
      const res = [];
      for (let p = 1; p <= 47; p++) if (p !== g.me && g.adjacentTo(f, p)) res.push(g.attack(p, f, false).why);
      window.__jinchi.CONFIG.ATTACK_SUCCESS = 0.85;
      return { defended: g.defendedDay[f] === g.day, owner: g.owner[f], me: g.me, res };
    }, f);
    assert(r.defended && r.owner === r.me, 'defended');
    assert(r.res.every((w) => w === 'defended'), 'attacks rejected ' + r.res);
    assert((await page.textContent('#banner')).includes('防御完了'), 'banner');
    await page.click('#cp-close');
  });

  await test('真上ビュー: 視点が真上になり、攻撃・防御はできない', async () => {
    await page.click('#btn-next'); await page.click('#m-btns button'); // DAY 3（未行動に戻す）
    await page.click('[data-act=top]');
    await page.waitForTimeout(900);
    const pitch = await ev(() => window.__jinchi.App.cam.pitch);
    assert(Math.abs(pitch - 90) < 0.5, 'pitch ' + pitch);
    const t = await findAttackable();
    const v = await ev((t) => { const { App } = window.__jinchi; const W = App.map.W; App.cam.goal = null; App.cam.tx = t % W + 0.5; App.cam.tz = ((t / W) | 0) + 0.5; App.cam.dist = 60; App.cam.compute(); const v = [0, 0]; return App.cam.project(t % W + 0.5, 0, ((t / W) | 0) + 0.5, v); }, t);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    assert(await page.isDisabled('#cp-action'), 'disabled in top view');
    assert((await page.textContent('#cp-action')).includes('真上ビュー'), 'reason');
    await ev(() => { window.__jinchi.App.cam.dist = 700; });
    await page.waitForTimeout(400);
    await shot('06_topview');
    await page.click('#cp-close');
    await page.click('[data-act=top]');
    await page.waitForTimeout(900);
    const pitch2 = await ev(() => window.__jinchi.App.cam.pitch);
    assert(Math.abs(pitch2 - 55) < 0.5, 'back to tilt ' + pitch2);
    assert(!(await ev(() => window.__jinchi.game.player.acted)), 'no action consumed');
  });

  await test('カメラ: ドラッグ移動・ホイール拡大縮小・キーボード・ミニマップ', async () => {
    await ev(() => { const c = window.__jinchi.App.cam; c.goal = null; c.dist = 300; });
    const c0 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz, c.dist]; });
    await page.mouse.move(200, 500); await page.mouse.down(); await page.mouse.move(260, 560, { steps: 5 }); await page.mouse.up();
    const c1 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz, c.dist]; });
    assert(c1[0] < c0[0] && c1[1] < c0[1], 'drag pans ' + c0 + ' -> ' + c1);
    await page.mouse.move(200, 500); await page.mouse.wheel(0, -600);
    const d1 = await ev(() => window.__jinchi.App.cam.dist);
    assert(d1 < c1[2], 'wheel zoom in');
    for (let k = 0; k < 20; k++) await page.mouse.wheel(0, 2000);
    const d2 = await ev(() => window.__jinchi.App.cam.dist);
    assert(d2 === 6500, 'zoom out to max ' + d2);
    for (let k = 0; k < 30; k++) await page.mouse.wheel(0, -2000);
    const d3 = await ev(() => window.__jinchi.App.cam.dist);
    assert(d3 === 5, 'zoom in to min ' + d3);
    await page.waitForTimeout(200);
    await shot('07_zoom_min');
    await page.keyboard.press('Minus');
    assert((await ev(() => window.__jinchi.App.cam.dist)) > 5, 'key zoom');
    const box = await page.locator('#minimap').boundingBox();
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.15);
    const goal = await ev(() => window.__jinchi.App.cam.goal);
    assert(goal && goal.x > 1800 && goal.z < 600, 'minimap fly ' + JSON.stringify(goal));
    await page.waitForTimeout(800);
    await page.click('[data-act=home]');
    await page.waitForTimeout(800);
    const home = await ev(() => { const { App } = window.__jinchi; const c = App.map.capitalCell[App.me]; return Math.hypot(App.cam.tz - ((c / App.map.W) | 0), App.cam.tx - c % App.map.W); });
    assert(home < 200, 'home ' + home);
  });

  await test('タッチ: 2本指ピンチで拡大縮小・1本指ドラッグで移動', async () => {
    const cdp = await page.context().newCDPSession(page);
    await ev(() => { const c = window.__jinchi.App.cam; c.goal = null; c.dist = 400; });
    const d0 = await ev(() => window.__jinchi.App.cam.dist);
    const tp = (pts) => pts.map(([x, y], id) => ({ x, y, id }));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[150, 420], [240, 420]]) });
    for (let k = 1; k <= 6; k++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[150 - k * 15, 420], [240 + k * 15, 420]]) });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const d1 = await ev(() => window.__jinchi.App.cam.dist);
    assert(d1 < d0 * 0.7, 'pinch zoom in ' + d0 + ' -> ' + d1);
    const t0 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp([[200, 420]]) });
    for (let k = 1; k <= 5; k++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp([[200 + k * 12, 420 + k * 12]]) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    const t1 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    assert(t1[0] < t0[0] && t1[1] < t0[1], 'touch drag pans');
    await cdp.detach();
  });

  await test('順位・日報ボタン', async () => {
    await page.click('[data-act=rank]');
    await page.waitForSelector('#modal:not(.hidden)');
    assert((await page.$$('#m-body .rank-row')).length === 47, '47 rows');
    await shot('08_ranking');
    await page.click('#m-btns button');
    await page.click('[data-act=report]');
    assert((await page.textContent('#m-title')).includes('日報'), 'report');
    await page.click('#m-btns button');
    assert(await page.isHidden('#modal'), 'closed');
  });

  await test(`リアルタイム進行: AIが90秒の中でばらばらに行動する`, async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game;
      const before = g.today.captures + g.today.defends;
      const times = g.queue.map((a) => a.time);
      return { before, n: times.length, min: Math.min(...times), max: Math.max(...times), qi: g.qi };
    });
    assert(r.n > 500, 'queue ' + r.n);
    assert(r.min < 5 && r.max > 85, 'spread ' + r.min + '..' + r.max);
    await page.waitForTimeout(2500);
    const after = await ev(() => { const g = window.__jinchi.game; return { a: g.today.captures + g.today.defends, qi: g.qi, t: g.time }; });
    assert(after.qi > r.qi && after.a > r.before && after.t > 2, 'progress in real time ' + JSON.stringify(after));
  });

  await test(`${DAYS}日間進めてもエラーなし・整合性OK`, async () => {
    // 1マスの持ち主変更が1日1回までかを監視
    await ev(() => {
      const g = window.__jinchi.game;
      window.__chk = { violations: 0, seen: new Map(), day: g.day };
      g.on('cell', (i) => {
        const c = window.__chk;
        if (c.day !== g.day) { c.day = g.day; c.seen = new Map(); }
        if (c.seen.has(i)) c.violations++;
        c.seen.set(i, 1);
      });
    });
    const t0 = Date.now();
    let processMax = 0;
    for (let d = 0; d < DAYS; d++) {
      const st = await ev(() => window.__jinchi.App.state);
      if (st !== 'PLAYING') break;
      // プレイヤーも毎日何か行動（攻撃か防御）
      await ev((d) => {
        const g = window.__jinchi.game; const fr = g.frontier[g.me];
        if (!fr.length) return;
        const f = fr[(d * 131) % fr.length];
        if (d % 3 === 2) { g.playerAct('defend', f); return; }
        let t = -1; g.forNeighbors(f, (j) => { if (t < 0 && g.owner[j] !== g.me && !g.canAttack(g.me, j)) t = j; });
        if (t >= 0) g.playerAct('attack', t);
      }, d);
      const tp = Date.now();
      await page.click('#btn-next');
      processMax = Math.max(processMax, Date.now() - tp);
      if (await page.isVisible('#modal')) {
        const title = await page.textContent('#m-title');
        if (title.includes('日報')) await page.click('#m-btns button');
        else break;
      }
      if (d % 10 === 9) {
        const inv = await ev(() => {
          const g = window.__jinchi.game, m = g.map;
          let sum = 0; for (let p = 1; p <= 47; p++) sum += g.counts[p];
          const cnt = new Int32Array(48); let bad = 0, fcount = 0, flist = 0;
          for (let i = 0; i < m.N; i++) {
            if (!m.initPref[i]) { if (g.owner[i]) bad++; continue; }
            cnt[g.owner[i]]++;
            const isF = g.isFrontierCell(i);
            if (isF) fcount++;
            if (isF !== (g.frontierPos[i] >= 0)) bad++;
            else if (isF && g.frontier[g.owner[i]][g.frontierPos[i]] !== i) bad++;
          }
          for (let p = 1; p <= 47; p++) { flist += g.frontier[p].length; if (cnt[p] !== g.counts[p]) bad++; }
          return { sum, land: m.landCells, bad, fcount, flist, day: g.day };
        });
        assert(inv.sum === inv.land, 'counts sum ' + inv.sum + ' vs ' + inv.land);
        assert(inv.bad === 0 && inv.fcount === inv.flist, 'frontier/count consistency ' + JSON.stringify(inv));
        console.log(`      day ${inv.day}: OK (県境マス ${inv.fcount})`);
      }
    }
    const fin = await ev(() => { const g = window.__jinchi.game; return { day: g.day, v: window.__chk.violations, me: g.counts[g.me], init: g.map.initCounts[g.me], rank: g.rankOf(g.me) }; });
    console.log(`      ${Date.now() - t0}ms, 日送り最大 ${processMax}ms, DAY ${fin.day}, 自県 ${fin.init}→${fin.me} (${fin.rank}位)`);
    assert(fin.v === 0, 'once-per-day violations ' + fin.v);
    assert(fin.day >= DAYS, 'reached day ' + fin.day);
    await ev(() => { const { App } = window.__jinchi; App.cam.goal = null; App.cam.dist = 800; });
    await page.waitForTimeout(500);
    await shot('09_after_days');
  });

  await test('勝利: 全国の規定割合を支配すると GAMEOVER（勝利）', async () => {
    await ev(() => {
      const J = window.__jinchi, g = J.game;
      // 最大の県から自県へマスを移し、自県を1位にしてから「あと1マスで勝利」の状態にする
      const big = g.ranking()[0];
      if (big !== g.me) {
        const give = Math.ceil((g.counts[big] - g.counts[g.me]) / 2) + 10;
        let n = 0;
        for (let i = 0; i < g.map.N && n < give; i++) if (g.owner[i] === big) { g.setOwner(i, g.me); n++; }
      }
      J.CONFIG.WIN_RATIO = (g.counts[g.me] + 1) / g.map.landCells;
      J.CONFIG.ATTACK_SUCCESS = 1;
      g.player.acted = false;
    });
    const t = await findAttackable();
    await ev((t) => window.__jinchi.App.selectCell(t), t);
    await page.click('#cp-action');
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    assert((await page.textContent('#m-body')).includes('天下統一'), 'win text');
    await shot('10_win');
    await ev(() => { window.__jinchi.CONFIG.WIN_RATIO = 0.5; window.__jinchi.CONFIG.ATTACK_SUCCESS = 0.85; });
    await page.click('#m-btns button');
    await page.waitForFunction(() => window.__jinchi.App.state === 'TITLE');
  });

  await test('敗北: 自県のマスが0になると GAMEOVER（敗北）→ タイトル → 再スタート', async () => {
    await page.click('.pbtn[data-p="31"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const oldListeners = await ev(() => { window.__oldGame = window.__jinchi.game; return Object.keys(window.__oldGame.listeners).length; });
    assert(oldListeners > 0, 'listeners registered');
    await ev(() => {
      const g = window.__jinchi.game; const mine = [];
      for (let i = 0; i < g.map.N; i++) if (g.owner[i] === g.me) mine.push(i);
      for (const i of mine) { g.setOwner(i, 32); }
      g.checkEnd();
    });
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    assert((await page.textContent('#m-body')).includes('敗北'), 'lose text');
    await shot('11_lose');
    await page.click('#m-btns button');
    await page.waitForFunction(() => window.__jinchi.App.state === 'TITLE');
    const cleaned = await ev(() => ({ l: Object.keys(window.__oldGame.listeners).length, g: window.__jinchi.game, hud: document.getElementById('hud').classList.contains('hidden'), log: document.getElementById('log').children.length }));
    assert(cleaned.l === 0 && cleaned.g === null && cleaned.hud, 'old game disposed ' + JSON.stringify(cleaned));
    await page.click('.pbtn[data-p="47"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const s = await ev(() => { const g = window.__jinchi.game; return { day: g.day, cells: g.counts[47], init: g.map.initCounts[47], logs: document.getElementById('log').children.length }; });
    assert(s.day === 1 && s.cells === s.init, 'fresh game ' + JSON.stringify(s));
    assert(s.logs <= 2, 'log cleared');
    await page.click('#btn-next');
    await page.click('#m-btns button');
    await page.waitForTimeout(1200);
    await shot('12_okinawa');
  });

  await test('コンソールエラーなし', async () => {
    assert(errors.length === 0, errors.join('\n'));
  });

  await browser.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
