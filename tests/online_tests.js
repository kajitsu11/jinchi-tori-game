// オンライン版のテスト：サーバーを起こし、通信の手順・建設・多人数の負荷・ブラウザでの表示を確かめる
//   node tests/online_tests.js        （BOTS=300 で同時接続の数を変える）
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');
const ROOT = path.resolve(__dirname, '..');
const PORT = 8091;
const BOTS = +(process.env.BOTS || 300);
let pass = 0, fail = 0;
const ok = (name, cond, info) => { if (cond) { pass++; console.log('PASS', name); } else { fail++; console.log('FAIL', name, info || ''); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function client(pref) {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  const c = { ws, msgs: [], bin: [], bytes: 0 };
  ws.on('message', (d, isBin) => { c.bytes += d.length; if (isBin) c.bin.push(d); else c.msgs.push(JSON.parse(d.toString())); });
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.waitFor = async (t, ms = 30000) => { const end = Date.now() + ms; for (;;) { const m = c.msgs.find((q) => q.t === t); if (m) return m; if (Date.now() > end) return null; await wait(50); } };
  c.join = async () => { await c.open; c.send({ t: 'hello', pref, name: 'bot' }); return c.waitFor('welcome'); };
  return c;
}

(async () => {
  const srv = spawn('node', [path.join(ROOT, 'server/server.js')], { env: { ...process.env, PORT, SEED: '7' }, stdio: ['ignore', 'pipe', 'inherit'] });
  let log = '';
  srv.stdout.on('data', (d) => { log += d; });
  try {
    for (let k = 0; k < 120 && !log.includes('listening'); k++) await wait(500);
    ok('server starts', log.includes('listening'), log);
    // ---- 手順：参加 → 範囲 → 細かい区画 → 建設 → 攻撃目標
    const a = client(13);
    const wel = await a.join();
    ok('welcome', wel && wel.S === 3 && wel.nodes.length > 500 && wel.pref === 13, JSON.stringify(wel && { S: wel.S, n: wel.nodes.length }));
    await wait(300);
    ok('coarse owner snapshot', a.bin.some((b) => b[0] === 1));
    const cap = wel.nodes[12], cx = cap[1] / 10, cy = cap[2] / 10;
    a.send({ t: 'view', x0: cx - 150, y0: cy - 150, x1: cx + 150, y1: cy + 150, u: true, b: true });
    const tiles = [];
    for (let ty = ((cy - 100) >> 6); ty <= ((cy + 100) >> 6); ty++) for (let tx = ((cx - 100) >> 6); tx <= ((cx + 100) >> 6); tx++) tiles.push(ty * wel.fineTW + tx);
    a.send({ t: 'sub', add: tiles });
    await wait(1500);
    const fine = a.bin.filter((b) => b[0] === 3);
    ok('fine tiles arrive', fine.length === tiles.length, `${fine.length}/${tiles.length}`);
    const snap = a.msgs.filter((m) => m.t === 'snap').pop();
    ok('snapshot has units near capital', snap && snap.u && snap.u.length > 0, snap && snap.u && snap.u.length);
    let built = null;
    for (let k = 0; k < 40 && !(built && built.ok); k++) {
      a.msgs.length = 0;
      a.send({ t: 'build', type: 'farm', x: cx + 30 + k * 4, y: cy + 20 });
      built = await a.waitFor('buildres', 5000);
    }
    ok('build farm', built && built.ok, JSON.stringify(built));
    await wait(1600);
    const st = a.msgs.filter((m) => m.t === 'stats').pop();
    ok('stats count my building', st && st.myB === 1 && st.res.wood < 400, JSON.stringify(st && { myB: st.myB, res: st.res }));
    const snap2 = a.msgs.filter((m) => m.t === 'snap' && m.ba && m.ba.some((b) => b[8] === 1)).pop();
    ok('my building in snapshot', !!snap2);
    a.send({ t: 'build', type: 'farm', x: 10, y: 10 });
    a.msgs.length = 0;
    const bad = await a.waitFor('buildres', 5000);
    ok('build in sea rejected', bad && !bad.ok && bad.why === 'sea', JSON.stringify(bad));
    // 同じ人としてつなぎ直す（トークン）
    const b2 = new WebSocket(`ws://localhost:${PORT}/ws`);
    const again = await new Promise((r) => { b2.on('open', () => b2.send(JSON.stringify({ t: 'hello', token: wel.token, pref: 1 }))); b2.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d.toString()); if (m.t === 'welcome') r(m); } }); });
    ok('reconnect keeps wallet and pref', again.w === wel.w && again.pref === 13, JSON.stringify({ w: again.w, pref: again.pref }));
    b2.close();
    // ---- 負荷：BOTS 人が同時につないで、それぞれ画面の範囲と細かい区画を受け取る
    const bots = [];
    for (let k = 0; k < BOTS; k++) bots.push(client(1 + (k % 47)));
    // 実際の参加は少しずつ。50人ずつ 0.3 秒おきにつなぐ
    const joins = [];
    for (let k = 0; k < bots.length; k++) { joins.push(bots[k].join()); if (k % 50 === 49) await wait(300); }
    const wels = await Promise.all(joins);
    ok(`${BOTS} bots joined`, wels.every(Boolean));
    bots.forEach((c, k) => {
      const n = wels[k].nodes[wels[k].pref - 1], x = n[1] / 10, y = n[2] / 10;
      c.send({ t: 'view', x0: x - 200, y0: y - 350, x1: x + 200, y1: y + 250, u: true, b: true });
      const add = [];
      for (let ty = ((y - 350) >> 6); ty <= ((y + 250) >> 6); ty++) for (let tx = ((x - 200) >> 6); tx <= ((x + 200) >> 6); tx++) add.push(ty * wels[k].fineTW + tx);
      c.send({ t: 'sub', add });
      if (k % 3 === 0) c.send({ t: 'build', type: 'farm', x: x + 25, y: y + 25 });
    });
    const b0 = bots.reduce((s, c) => s + c.bytes, 0);
    await wait(10000);
    const health = await (await fetch(`http://localhost:${PORT}/health`)).json();
    const b1 = bots.reduce((s, c) => s + c.bytes, 0);
    const perBot = (b1 - b0) / BOTS / 10;
    console.log(`  online ${health.online}, sim ${health.perf.simMs.toFixed(1)}ms/100ms, send ${health.perf.sendMs.toFixed(1)}ms/500ms, rss ${(health.rss / 1e6) | 0}MB, recv ${(perBot / 1024).toFixed(1)}KB/s per bot (deflate)`);
    ok('server keeps up with bots', health.perf.simMs + health.perf.sendMs / 5 < 60, JSON.stringify(health.perf));
    bots.forEach((c) => c.ws.close());
    a.ws.close();
    // ---- ブラウザ：online.html を開いて参加し、地面・細かい区画・建設
    const { chromium } = require('playwright');
    const br = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
    const page = await br.newPage({ viewport: { width: 390, height: 844 } });
    page.setDefaultTimeout(120000);
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__jinchi && window.__jinchi.App.state === 'TITLE');
    await page.evaluate(() => { const A = window.__jinchi.App; A.selectTitlePref(27, false); A.startGame(27); });
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    await page.waitForFunction(() => { const A = window.__jinchi.App; return A.renderer.fineSlot.size > 0 && A.game.snapAt > 0; }, null, { timeout: 30000 });
    const r = await page.evaluate(async () => {
      const A = window.__jinchi.App, g = A.game, n = g.nodes[A.me - 1];
      let res = null, failed = 0;
      g.on('buildfail', () => { failed++; });
      // サーバーに断られたら（AIの建物と近すぎるなど）、場所を変えて建て直す
      for (let k = 0; k < 30; k++) {
        const x = n.x - 30 - k * 4, y = n.y + 25, f0 = failed;
        res = g.playerBuild('farm', A.map.id(x, y), x, y);
        if (!res.ok) continue;
        await new Promise((ok) => setTimeout(ok, 1500));
        if (failed === f0) break;
      }
      await new Promise((ok) => setTimeout(ok, 1500));
      return { res, myB: g.myB, fine: A.renderer.fineSlot.size, map: [A.map.W, A.map.H], me: A.me };
    });
    ok('browser joins and builds', r.res.ok && r.myB >= 1 && r.fine > 0 && r.map[0] === 21600 && r.me === 27, JSON.stringify(r));
    ok('browser no errors', errs.length === 0, errs.join(' | '));
    await br.close();
  } catch (e) {
    fail++; console.log('FAIL exception', e);
  } finally {
    srv.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
