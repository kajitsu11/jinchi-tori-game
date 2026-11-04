// Playwright による自動テスト（RTS版）
//   python3 tools/build.py && node tests/run_tests.js
//   HOURS=24 node tests/run_tests.js   （長時間テストのゲーム内時間を変更。7日間の確認は tools/season_sim.js）
// スクリーンショットは test-results/ に保存される。
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html') + '?seed=12345';
const OUT = path.join(ROOT, 'test-results');
const HOURS = +(process.env.HOURS || 6);
fs.mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); }

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  page.setDefaultTimeout(120000);   // ソフト描画のテスト環境では1枚の描画に時間がかかることがある
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
  const ev = (fn, arg) => page.evaluate(fn, arg);
  /** ゲーム内時間を sec 秒ぶん即座に進める（描画とは無関係に Sim.step を回す） */
  const advance = (sec) => ev((sec) => { const g = window.__jinchi.game; for (let k = 0; k < Math.round(sec / 0.5); k++) g.step(0.5); }, sec);
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

  // 自県の領土で、ある建物を建てられるマスを探す（県庁の近くから順に）
  const findSite = (type, P) => ev(({ type, P }) => {
    const g = window.__jinchi.game, W = g.map.W;
    const me = P || g.me;
    const nodes = g.nodes.filter((n) => n.owner === me).sort((a, b) => (b.type === 'capital') - (a.type === 'capital'));
    for (const n of nodes) {
      for (let r = 3; r < 40; r += 1.5) for (let a = 0; a < 6.28; a += 0.4) {
        const c = g.cellAt(n.x + Math.cos(a) * r, n.y + Math.sin(a) * r);
        if (!g.canBuild(type, me, c, me === g.me && !P ? 0 : me)) return c;
      }
    }
    return -1;
  }, { type, P });
  const cellXY = (c) => ev((c) => { const m = window.__jinchi.App.map; return [m.X(c) + 0.5, m.Y(c) + 0.5]; }, c);
  const richPlayer = () => ev(() => { const g = window.__jinchi.game; for (const r of ['food', 'wood', 'gold']) g.res[r][0] = 20000; });

  await test('読み込み → TITLE 状態になる', async () => {
    const t0 = Date.now();
    await page.addInitScript(() => (window.JINCHI_ORIENT = 'port'));   // 縦画面のまま確かめる（基本は横画面）
    await page.goto(URL);
    await page.waitForFunction(() => (window.__jinchi && window.__jinchi.App.state === 'TITLE') || window.__jinchiError, null, { timeout: 60000 });
    assert(!(await ev(() => window.__jinchiError || null)), 'load error');
    console.log(`      load ${Date.now() - t0}ms`);
    const info = await ev(() => {
      const m = window.__jinchi.App.map;
      return { W: m.W, H: m.H, land: m.landCells, prefs: m.prefs.filter(Boolean).length, de: m.raw.minNeighborDeltaE,
        towns: m.raw.towns.length, elev: m.elev.length, src: document.querySelector('.credit').textContent };
    });
    assert(info.W === 7200 && info.H === 7530, 'grid size');
    assert(info.land > 5000000 && info.land < 6000000, 'land cells ' + info.land);
    assert(info.prefs === 47 && info.de >= 70, 'prefs / deltaE');
    assert(info.towns > 400 && info.elev === 1800 * 1882, 'towns/elev');
    assert(info.src.includes('地球地図日本（国土地理院）'), '出典表示');
    await page.waitForTimeout(800);
    await shot('01_title');
  });

  await test('タイトル: 地図タップで県を選べる', async () => {
    const hok = await ev(() => window.__jinchi.App.map.capitalCell[1]);
    const v = await ev((c) => { const { App } = window.__jinchi; const m = App.map; App.cam.compute(); const v = [0, 0]; return App.cam.project(m.X(c) + 0.5, 0, m.Y(c) + 0.5, v); }, hok);
    await page.mouse.click(v[0], v[1]);
    assert((await ev(() => window.__jinchi.App.titleSel)) === 1, 'titleSel');
  });

  await test('出陣 → 資源・建築メニュー・初期の兵士', async () => {
    await page.click('.pbtn[data-p="20"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const s = await ev(() => {
      const g = window.__jinchi.game;
      return { parts: g.parts[g.me], nodes: g.nodes.length, units: g.units.length, mineU: g.unitCount(g.me),
        food: g.res.food[0], wood: g.res.wood[0], cards: document.querySelectorAll('.bcard').length, pref: document.getElementById('h-pref').textContent };
    });
    assert(s.parts === Math.max(3, Math.round(204.8 / 100 * 8)), 'participants');
    assert(s.nodes > 500 && s.units > 400 && s.mineU === Math.round(s.parts * 0.5) + 1, JSON.stringify(s));   // ＋あなたの大将
    assert(s.food > 0 && s.wood > 0 && s.cards >= 5 && s.pref === '長野県', JSON.stringify(s));
    await page.waitForTimeout(1500);
    await shot('02_playing');
  });

  await test('沖縄: 左下のインセットにあり、航路で鹿児島とつながる', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, m = g.map, W = m.W;
      const cap = m.capitalCell[47], kago = m.capitalCell[46], hok = m.capitalCell[1];
      const okNodes = g.nodes.filter((n) => n.pref === 47).map((n) => n.id);
      const adjPrefs = new Set();
      for (const id of okNodes) for (const a of g.nodeAdj[id]) if (g.nodes[a].pref !== 47) adjPrefs.add(g.nodes[a].pref);
      const path = g.nav.find(m.X(kago) + 0.5, m.Y(kago) + 0.5, m.X(cap) + 0.5, m.Y(cap) + 0.5);
      const ll = m.lonLat(m.X(cap), m.Y(cap));
      return { capY: m.Y(cap), kagoY: m.Y(kago), capX: m.X(cap), hokX: m.X(hok), adj: [...adjPrefs], path: path ? path.length : -1, ll };
    });
    assert(r.capY > r.kagoY && r.capX < r.hokX - 1600, '配置 ' + JSON.stringify(r));
    assert(r.adj.length >= 1 && r.adj.every((p) => p === 46), '隣接は鹿児島のみ ' + r.adj);
    assert(r.path > 0, '鹿児島から那覇へ経路がある');
    assert(Math.abs(r.ll[0] - 127.68) < 0.05 && Math.abs(r.ll[1] - 26.21) < 0.05, '経緯度 ' + r.ll);
  });

  await test('建設: 農場カード → 自県の領土をタップで建つ・資源が減る', async () => {
    await ev(() => { window.__jinchi.game.aiBuildAt.fill(1e9); });   // AIの建築を止めて、置き場所を確実にする
    const site = await findSite('farm');
    assert(site >= 0, 'site');
    const [x, z] = await cellXY(site);
    const before = await ev(() => { const g = window.__jinchi.game; return { wood: g.res.wood[0], n: g.buildings.length }; });
    // 三人称視点：建築 → カードを選ぶ → 大将の目の前のマスに設計図 → 「建てる」
    await page.click('#t-build');
    await page.click('.bcard[data-b="farm"]');
    assert((await ev(() => window.__jinchi.App.build && window.__jinchi.App.build.type)) === 'farm', 'build mode');
    await ev(([x, z]) => { const { App, TPS } = window.__jinchi, g = App.game.general; g.x = x; g.y = z + TPS.REACH; App.tps.yaw = 0; }, [x, z]);
    await page.waitForFunction((c) => { const G = window.__jinchi.App.ghost; return G && G.cell === c; }, site, { timeout: 20000 }).catch(() => {});
    const gh = await ev(() => { const G = window.__jinchi.App.ghost; return G && [G.cell, G.why]; });
    assert(gh && gh[0] === site && !gh[1], 'ghost on site ' + JSON.stringify(gh) + ' ' + site);
    await page.click('#bc-place');
    const after = await ev(() => { const g = window.__jinchi.game; const b = g.buildings[g.buildings.length - 1]; return { wood: g.res.wood[0], n: g.buildings.length, type: b && b.type, wallet: b && b.wallet }; });
    assert(after.n === before.n + 1 && after.type === 'farm' && after.wallet === 0, JSON.stringify(after));
    // タップするまでの間にも木材の収入（+1.2/秒）が入るので、建設費60から少し小さくてもよい
    assert(before.wood - after.wood >= 50, 'paid ' + (before.wood - after.wood));
    assert((await page.textContent('#log')).includes('農場を建てました'), 'log');
    await page.waitForTimeout(300);
    await shot('03_farm');
    await page.keyboard.press('Escape');
    assert((await ev(() => window.__jinchi.App.build)) === null, 'esc cancels');
  });

  await test('建設できない場所（他県・海）では建たない', async () => {
    const enemy = await ev(() => { const g = window.__jinchi.game; const n = g.nodes.find((q) => q.owner !== g.me && q.owner === 15); return [n.x + 3, n.y + 3]; });
    await page.click('#t-build');
    await page.click('.bcard[data-b="farm"]');
    await ev(([x, z]) => { const { App, TPS } = window.__jinchi, g = App.game.general; g.x = x; g.y = z + TPS.REACH; App.tps.yaw = 0; }, enemy);
    await page.waitForFunction(() => { const G = window.__jinchi.App.ghost; return G && G.why === 'notown'; }, null, { timeout: 20000 }).catch(() => {});
    assert((await ev(() => window.__jinchi.App.ghost && window.__jinchi.App.ghost.why)) === 'notown', 'not own land');
    assert((await page.textContent('#bc-place')).includes('自県の領土の外'), 'reason shown');
    const n0 = await ev(() => window.__jinchi.game.buildings.length);
    await page.click('#bc-place');
    assert((await ev(() => window.__jinchi.game.buildings.length)) === n0, 'not built');
    assert((await page.textContent('#banner')).includes('建設できません'), 'banner');
    await page.keyboard.press('Escape');
  });

  await test('製材所は森の近くだけ・木材の収入が増える', async () => {
    await richPlayer();
    const r = await ev(() => {
      const g = window.__jinchi.game, W = g.map.W;
      // 森の少ないマスでは建てられない
      let bad = -1;
      for (const i of g.landIdx) if (g.owner[i] === g.me && g.forestNear(i, 6) === 0 && !g.canBuild('farm', g.me, i, 0)) { bad = i; break; }
      const why = bad >= 0 ? g.canBuild('lumber', g.me, bad, 0) : 'noforest';
      return { why };
    });
    assert(r.why === 'noforest', 'noforest ' + r.why);
    const site = await findSite('lumber');
    const s = await ev((site) => {
      const g = window.__jinchi.game;
      g.produce(1); const w0 = g.income.wood;
      const res = g.playerBuild('lumber', site);
      g.produce(1);
      return { ok: res.ok, w0, w1: g.income.wood, forest: res.building && res.building.forest };
    }, site);
    assert(s.ok && s.w1 > s.w0 && s.forest >= 8, JSON.stringify(s));
  });

  await test('兵舎: 食料を使ってあなたの兵士を訓練する', async () => {
    await richPlayer();
    const site = await findSite('barracks');
    const s = await ev((site) => {
      const g = window.__jinchi.game;
      const r = g.playerBuild('barracks', site);
      const t0 = g.stats.trainedMine;
      for (let k = 0; k < 1300; k++) g.step(1);   // 兵舎の訓練は10分ごと（訓練した兵士はすぐ戦いに出るので、訓練した人数で確かめる）
      return { ok: r.ok, trained: g.stats.trainedMine - t0 };
    }, site);
    assert(s.ok && s.trained >= 1, JSON.stringify(s));
  });

  await test('町: 建てると国境が広がり、自分の拠点になる', async () => {
    await richPlayer();
    const site = await findSite('town');
    assert(site >= 0, 'town site');
    const s = await ev((site) => {
      const g = window.__jinchi.game, me = g.me;
      const c0 = g.counts[me], n0 = g.nodeCount[me];
      const r = g.playerBuild('town', site);
      return { ok: r.ok, c0, c1: g.counts[me], n0, n1: g.nodeCount[me], byPlayer: r.node && r.node.byPlayer, type: r.node && r.node.type };
    }, site);
    assert(s.ok && s.n1 === s.n0 + 1 && s.byPlayer && s.type === 'town' && s.c1 >= s.c0, JSON.stringify(s));
    const [x, z] = await cellXY(site);
    await toScreen(x, z, 80);
    await page.waitForTimeout(400);
    await shot('04_town');
  });

  await test('見張り塔: 近くの敵兵を撃つ', async () => {
    await richPlayer();
    const site = await findSite('tower');
    const s = await ev((site) => {
      const g = window.__jinchi.game;
      const r = g.playerBuild('tower', site);
      const b = r.building;
      const e = g.units.find((u) => u.pref !== g.me);
      e.x = e.px = b.x + 4; e.y = e.py = b.y; e.hp = 100; e.thinkAt = 1e9; e.path = null; e.dest = null;
      for (const u of g.units) if (u !== e && Math.hypot(u.x - b.x, u.y - b.y) < 12) { u.x = u.px = u.x + 300; }
      let minHp = 100;
      for (let k = 0; k < 40; k++) { e.x = b.x + 4; e.y = b.y; g.step(0.5); if (!e.alive) { minHp = 0; break; } minHp = Math.min(minHp, e.hp); }
      return { ok: r.ok, hp: minHp };
    }, site);
    assert(s.ok && s.hp < 100, JSON.stringify(s));
  });

  await test('核ミサイル基地：あなたが着弾地点を選んで発射、半径の中の兵・建物が全て消えて焦土になる', async () => {
    await richPlayer();
    const r = await ev(() => {
      const g = window.__jinchi.game, m = g.map, me = g.me;
      for (const r of ['wood', 'gold']) g.res[r][0] = 50000;
      // 自県の中で建てられる所
      let site = -1;
      const cap = g.nodes.find((n) => n.owner === me && n.type === 'capital') || g.nodes.find((n) => n.owner === me);
      for (let rr = 4; rr < 60 && site < 0; rr += 2) for (let a = 0; a < 6.28 && site < 0; a += 0.3) { const c = g.cellAt(cap.x + Math.cos(a) * rr, cap.y + Math.sin(a) * rr); if (c >= 0 && !g.canBuild('nuke', me, c, 0)) site = c; }
      if (site < 0) return { err: 'nosite' };
      const b = g.playerBuild('nuke', site).building;
      // 敵の拠点に向けて
      const foe = g.nodes.find((n) => n.owner !== me && n.owner > 0 && n.type !== 'capital') || g.nodes.find((n) => n.owner !== me);
      const R = g.nukeRadius();
      const inside = () => { let u = 0, bb = 0; for (const q of g.units) if (q.alive && !q.ghost && (q.x - foe.x) ** 2 + (q.y - foe.y) ** 2 < R * R * 0.9) u++; for (const q of g.buildings) if ((q.x - foe.x) ** 2 + (q.y - foe.y) ** 2 < R * R * 0.9) bb++; return [u, bb]; };
      for (let k = 0; k < 6; k++) g.spawnUnit(foe.owner, foe.x, foe.y, 3, -1);
      const before = inside();
      const shot = g.launchNuke(0, b, foe.x, foe.y);
      const again = g.launchNuke(0, b, foe.x, foe.y);   // すぐにもう一度は撃てない
      const WASTE_ID = 48, w0 = g.counts[WASTE_ID];
      for (let k = 0; k < 40; k++) g.step(0.25);
      return { ok: shot.ok, again: again.ok, before, after: inside(), waste: g.counts[WASTE_ID] - w0, nodeAlive: g.nodes[foe.id].owner > 0 };
    });
    assert(!r.err, r.err);
    assert(r.ok && !r.again, 'launch & cooldown ' + JSON.stringify(r));
    assert(r.before[0] > 0 && r.after[0] === 0 && r.after[1] === 0, 'wiped out ' + JSON.stringify(r));
    assert(r.waste > 100, 'scorched ' + JSON.stringify(r));
  });

  await test('敵兵は守りのない建物を壊す', async () => {
    const s = await ev(() => {
      const g = window.__jinchi.game;
      const b = g.buildings.find((q) => q.wallet === 0 && q.type === 'farm');
      const ens = g.units.filter((u) => u.pref !== g.me).slice(0, 4);
      for (const u of g.units) if (u.pref === g.me && Math.hypot(u.x - b.x, u.y - b.y) < 15) { u.x = u.px = u.x + 300; }
      let destroyed = false;
      g.on('destroyed', (q) => { if (q === b) destroyed = true; });
      for (let k = 0; k < 900 && !destroyed; k++) {
        for (const e of ens) { if (!e.alive) continue; e.x = e.px = b.x + 1.5; e.y = e.py = b.y; e.hp = 100; e.thinkAt = 1e9; }
        g.step(1);
      }
      for (const e of ens) e.thinkAt = 0;
      return { destroyed, inList: g.buildings.includes(b) };
    });
    assert(s.destroyed && !s.inList, JSON.stringify(s));
  });

  await test('占領されると、その拠点の領土にある建物は相手のものになる', async () => {
    await richPlayer();
    const s = await ev(() => {
      const g = window.__jinchi.game, me = g.me;
      // あなたの建物がある自県の拠点
      const b = g.buildings.find((q) => q.wallet === 0);
      const n = g.nodes[g.nodeOf[b.cell]];
      const enemy = me === 15 ? 21 : 15;
      g.capture(n, enemy);
      return { owner: b.owner, wallet: b.wallet, enemy, cell: g.owner[b.cell] };
    });
    assert(s.owner === s.enemy && s.wallet === s.enemy && s.cell === s.enemy, JSON.stringify(s));
  });

  await test('三人称視点: スティック・WASDで大将が歩き、なぞると見回す。地図ビューでは建てられない', async () => {
    const p0 = await ev(() => { const { App } = window.__jinchi, g = App.game.general; const c = App.game.nodes.find((n) => n.owner === App.me && n.type === 'capital') || App.game.nodes.find((n) => n.owner === App.me); g.x = c.x; g.y = c.y + 4; App.tps.yaw = 0; return [g.x, g.y, App.view]; });
    assert(p0[2] === 'tps', 'starts in tps');
    // 描画が遅い環境でも確かめられるよう、動くまで押し続ける
    await page.keyboard.down('w');
    await page.waitForFunction((y) => window.__jinchi.App.game.general.y < y - 0.05, p0[1], { timeout: 30000 }).catch(() => {});
    await page.keyboard.up('w');
    const p1 = await ev(() => { const g = window.__jinchi.App.game.general; return [g.x, g.y]; });
    assert(p1[1] < p0[1] - 0.05 && Math.abs(p1[0] - p0[0]) < 0.05, 'walks forward (−z) ' + JSON.stringify([p0, p1]));
    // スティック
    const jb = await page.locator('#joy').boundingBox();
    await page.mouse.move(jb.x + jb.width / 2, jb.y + jb.height / 2); await page.mouse.down();
    await page.mouse.move(jb.x + jb.width / 2 + 40, jb.y + jb.height / 2, { steps: 3 });
    await page.waitForFunction((x) => window.__jinchi.App.game.general.x > x + 0.05, p1[0], { timeout: 30000 }).catch(() => {});
    const p2 = await ev(() => { const g = window.__jinchi.App.game.general; return [g.x, g.y]; });
    await page.mouse.up();
    assert(p2[0] > p1[0] + 0.05, 'joystick right ' + JSON.stringify([p1, p2]));
    const y0 = await ev(() => window.__jinchi.App.tps.yaw);
    await page.mouse.move(300, 450); await page.mouse.down(); await page.mouse.move(220, 450, { steps: 5 }); await page.mouse.up();
    assert((await ev(() => window.__jinchi.App.tps.yaw)) !== y0, 'drag looks around');
    const cam = await ev(() => { const { App } = window.__jinchi, c = App.cam, g = App.game.general; return { d: Math.hypot(c.tx - g.x, c.tz - g.y), dist: c.dist, pitch: c.pitch }; });
    assert(cam.d < 1 && cam.dist < 10 && cam.pitch < 40, 'camera behind general ' + JSON.stringify(cam));
    await shot('04_tps');
    // 地図ビュー：見るだけ
    await page.click('#t-map');
    assert((await ev(() => window.__jinchi.App.view)) === 'map', 'map view');
    assert(!(await page.isVisible('#joy')) && !(await page.isVisible('#buildmenu')), 'no controls on map');
    await ev(() => window.__jinchi.App.startPlace('farm'));
    assert((await ev(() => window.__jinchi.App.build)) == null, 'cannot build on map');
    const gp = await ev(() => { const g = window.__jinchi.App.game.general; return [g.x, g.y]; });
    await page.keyboard.down('w'); await page.waitForTimeout(400); await page.keyboard.up('w');
    const gp2 = await ev(() => { const g = window.__jinchi.App.game.general; return [g.x, g.y]; });
    assert(gp[0] === gp2[0] && gp[1] === gp2[1], 'general does not move in map view');
    await page.click('#mb-back');
    assert((await ev(() => window.__jinchi.App.view)) === 'tps', 'back to tps');
    await page.click('#t-map');   // 以下のテストは地図ビューで
  });

  await test('攻撃目標: 敵の拠点を指定すると、あなたの兵士がそこへ向かう', async () => {
    await ev(() => { const A = window.__jinchi.App; A.endBuild(); A.setView('map'); });   // 前のテストが途中で止まっても地図ビューで続ける
    const tgt = await ev(() => {
      const g = window.__jinchi.game, me = g.me;
      for (const n of g.nodes) if (n.owner === me) for (const a of g.nodeAdj[n.id]) { const e = g.nodes[a]; if (e.owner !== me) return [e.id, e.x, e.y]; }
      return null;
    });
    assert(tgt, 'target');
    await ev(() => window.__jinchi.App.toggleRallyMode());
    assert((await ev(() => window.__jinchi.App.mode && window.__jinchi.App.mode.kind)) === 'rally', 'rally mode');
    const v = await toScreen(tgt[1], tgt[2], 80);
    await page.mouse.click(v[0], v[1]);
    const s = await ev((id) => {
      const g = window.__jinchi.game;
      for (let k = 0; k < 40; k++) g.step(0.5);
      const mine = g.units.filter((u) => u.fromPlayer && !u.isGeneral);   // 大将は攻撃目標ではなく、あなたのタップで動く
      return { rally: g.rally, n: mine.length, going: mine.filter((u) => u.goalNode === id || u.chase >= 0 || u.engaged >= 0).length };
    }, tgt[0]);
    assert(s.rally === tgt[0], 'rally set ' + JSON.stringify(s));
    assert(s.n === 0 || s.going > 0, 'units going ' + JSON.stringify(s));
    assert((await page.textContent('#btn-rally')).includes('目標'), 'label');
  });

  await test('兵士の絵（スプライト）を描く', async () => {
    const atlas = await ev(() => { const p = window.__jinchi.App.painter; return p && [p.w, p.h]; });
    assert(atlas && atlas[0] === 2048 && atlas[1] >= 1024, 'atlas ' + atlas);
    await ev(() => {
      const { App } = window.__jinchi, g = App.game;
      const u = g.units.find((q) => q.engaged >= 0) || g.units[0];
      App.cam.goal = null; App.cam.tx = u.x; App.cam.tz = u.y + 1; App.cam.dist = 9;
    });
    await page.waitForTimeout(800);
    const n = await ev(() => { const { App } = window.__jinchi; App.cam.compute(); App.buildScene(); return App.sprites.count; });
    assert(n > 0, 'soldier sprites drawn');
    await shot('14_soldiers');
  });

  await test('建物をタップすると情報パネルが出る', async () => {
    const b = await ev(() => { const g = window.__jinchi.game; const b = g.buildings.find((q) => q.owner === g.me) || g.buildings[0]; return [b.x, b.y, b.type]; });
    const v = await toScreen(b[0], b[1], 50);
    await page.mouse.click(v[0], v[1]);
    await page.waitForSelector('#cellpanel:not(.hidden)');
    const name = await page.textContent('#cp-name');
    assert(name.length > 1, name);
    await page.click('#cp-close');
  });

  await test('真上ビューと戻る', async () => {
    await page.click('[data-act=top]');
    await page.waitForFunction(() => Math.abs(window.__jinchi.App.cam.pitch - 90) < 0.5, null, { timeout: 15000 }).catch(() => {});
    assert(Math.abs((await ev(() => window.__jinchi.App.cam.pitch)) - 90) < 0.5, 'top');
    await ev(() => { window.__jinchi.App.cam.dist = 900; });
    await page.waitForTimeout(400);
    await shot('06_topview');
    await page.click('[data-act=top]');
    await page.waitForFunction(() => Math.abs(window.__jinchi.App.cam.pitch - window.__jinchi.CONFIG.CAMERA_PITCH) < 0.5, null, { timeout: 15000 }).catch(() => {});
    assert(Math.abs((await ev(() => window.__jinchi.App.cam.pitch)) - (await ev(() => window.__jinchi.CONFIG.CAMERA_PITCH))) < 0.5, 'tilt');
  });

  await test('カメラ: ドラッグ移動・ホイール拡大縮小・キーボード・ミニマップ・自県へ', async () => {
    await ev(() => { const c = window.__jinchi.App.cam; c.goal = null; c.dist = 300; });
    const c0 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    await page.mouse.move(200, 500); await page.mouse.down(); await page.mouse.move(260, 560, { steps: 5 }); await page.mouse.up();
    const c1 = await ev(() => { const c = window.__jinchi.App.cam; return [c.tx, c.tz]; });
    assert(c1[0] < c0[0] && c1[1] < c0[1], 'drag pans');
    // ドラッグはタップ扱いにならない（移動命令は出ない）
    for (let k = 0; k < 20; k++) await page.mouse.wheel(0, 2000);
    assert((await ev(() => window.__jinchi.App.cam.dist)) === (await ev(() => window.__jinchi.CONFIG.ZOOM_MAX)), 'zoom max');
    for (let k = 0; k < 40; k++) await page.mouse.wheel(0, -2000);
    assert((await ev(() => window.__jinchi.App.cam.dist)) === (await ev(() => window.__jinchi.CONFIG.ZOOM_MIN)), 'zoom min');
    await page.waitForTimeout(200);
    await shot('07_zoom_min');
    await page.keyboard.press('Minus');
    assert((await ev(() => window.__jinchi.App.cam.dist)) > 5, 'key zoom');
    const box = await page.locator('#minimap').boundingBox();
    await page.mouse.click(box.x + box.width * 0.85, box.y + box.height * 0.15);
    const goal = await ev(() => window.__jinchi.App.cam.goal);
    assert(goal && goal.x > 3400, 'minimap ' + JSON.stringify(goal));
    await page.waitForTimeout(800);
    await page.click('[data-act=home]');
    await page.waitForTimeout(900);
    // カメラは目標地点へ動いている途中かもしれないので、目標地点で確かめる
    const du = await ev(() => { const { App } = window.__jinchi, n = App.game.nodes.find((q) => q.owner === App.me); const g = App.cam.goal || { x: App.cam.tx, z: App.cam.tz }; return Math.hypot(g.x - n.x, g.z - n.y); });
    assert(du < 400, 'home focus ' + du);
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
    await page.click('#m-btns button:last-child');
    assert(await page.isHidden('#modal'), 'closed');
  });

  await test(`${HOURS}時間進めてもエラーなし・整合性OK`, async () => {
    await ev(() => { const g = window.__jinchi.game; for (let p = 1; p <= 47; p++) g.aiBuildAt[p] = g.time + Math.random() * 3; });
    const r = await ev((min) => {
      const g = window.__jinchi.game, m = g.map;
      const t = performance.now();
      const steps = min * 3600 / 2;   // 2秒刻み（サーバーや早送りと同じ）
      let worst = 0;
      for (let k = 0; k < steps && !g.over; k++) { const s = performance.now(); g.step(2); worst = Math.max(worst, performance.now() - s); }
      const ms = performance.now() - t;
      let sum = g.counts[48]; for (let p = 1; p <= 47; p++) sum += g.counts[p];   // 48 = 焦土（核ミサイルで焼けた土地）
      const cnt = new Int32Array(49), nc = new Int32Array(49);
      let badOwner = 0, badPos = 0, badB = 0, badRes = 0;
      for (const i of g.landIdx) { cnt[g.owner[i]]++; if (g.owner[i] !== 48 && g.owner[i] !== g.nodes[g.nodeOf[i]].owner) badOwner++;   // 焦土は拠点の持ち主と違ってよい }
      for (const n of g.nodes) nc[n.owner]++;
      let badCnt = 0; for (let p = 1; p <= 47; p++) { if (cnt[p] !== g.counts[p]) badCnt++; if (nc[p] !== g.nodeCount[p]) badCnt++; }
      for (const u of g.units) if (!Number.isFinite(u.x) || !Number.isFinite(u.y) || u.x < 0 || u.y < 0 || u.x > m.W || u.y > m.H) badPos++;
      for (const b of g.buildings) if (b.owner !== g.owner[b.cell] || b.hp <= 0) badB++;
      for (const r of ['food', 'wood', 'gold']) for (let w = 0; w <= 47; w++) if (!Number.isFinite(g.res[r][w]) || g.res[r][w] < -1e-6) badRes++;
      return { sum, land: m.landCells, badOwner, badCnt, badPos, badB, badRes, perStep: +(ms / steps).toFixed(2), worst: +worst.toFixed(1),
        stats: g.stats, units: g.units.length, buildings: g.buildings.length, nodes: g.nodes.length, time: Math.round(g.time), over: g.over };
    }, HOURS);
    console.log(`      ${JSON.stringify(r)}`);
    assert(r.sum === r.land, 'sum');
    assert(!r.badOwner && !r.badCnt && !r.badPos && !r.badB && !r.badRes, 'consistency ' + JSON.stringify(r));
    assert(r.stats.captures > 3 && r.stats.built > 300 && r.stats.trained > 100, 'activity');
    assert(r.perStep < 15, 'performance ' + r.perStep);
    await ev(() => { const { App } = window.__jinchi; App.cam.goal = null; App.cam.dist = 900; App.updateHud(true); });
    await page.waitForTimeout(600);
    await shot('09_after_minutes');
    await ev(() => { const { App } = window.__jinchi; App.goHome(70); });
    await page.waitForTimeout(1200);
    await shot('10_close');
  });

  await test('脱落: 全ての拠点を失った県は脱落し、兵士もいなくなる', async () => {
    const r = await ev(() => {
      const g = window.__jinchi.game, victim = g.me === 31 ? 30 : 31, by = victim === 31 ? 32 : 29;
      for (const n of g.nodes) if (n.owner === victim) g.capture(n, by);
      const log = [...document.querySelectorAll('#log div')].some((d) => d.textContent.includes('脱落'));
      for (let k = 0; k < 100; k++) g.step(0.5);
      return { elim: g.eliminated.has(victim), nodes: g.nodeCount[victim], cells: g.counts[victim], alive: g.units.filter((u) => u.pref === victim).length, log };
    });
    assert(r.elim && r.nodes === 0 && r.cells === 0 && r.alive === 0 && r.log, JSON.stringify(r));
  });

  await test('勝利: 全国の規定割合を支配すると GAMEOVER（勝利）', async () => {
    await ev(() => { const J = window.__jinchi, g = J.game; J.CONFIG.WIN_RATIO = (g.pop[g.me] - 0.01) / g.popTotal; g.checkEnd(); });
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    assert((await page.textContent('#m-body')).includes('天下統一'), 'win text');
    await shot('10_win');
    await ev(() => { window.__jinchi.CONFIG.WIN_RATIO = 0.5; });
    await page.click('#m-btns button:last-child');
    await page.waitForFunction(() => window.__jinchi.App.state === 'TITLE');
  });

  await test('シーズン: 7日たつと支配人口1位の県が優勝して終わる', async () => {
    await page.click('.pbtn[data-p="13"]');
    await page.click('#btn-start');
    await page.waitForFunction(() => window.__jinchi.App.state === 'PLAYING');
    const t = await page.textContent('#h-left');
    assert(t.includes('残り7日') || t.includes('残り6日'), 'left ' + t);
    await ev(() => { const g = window.__jinchi.game; g.time = window.__jinchi.CONFIG.SEASON_DAYS * 86400 - 1; g.step(2); });
    await page.waitForFunction(() => window.__jinchi.App.state === 'GAMEOVER', null, { timeout: 5000 });
    const r = await ev(() => window.__jinchi.game.over);
    assert(r.reason === 'season', JSON.stringify(r));
    assert((await page.textContent('#m-body')).includes(r.win ? 'シーズン優勝' : 'シーズン終了'), 'season text');
    await page.click('#m-btns button:last-child');
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
    await page.click('#m-btns button:last-child');
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

  await test('縦に持っても最初から横画面（画面ごと回す）・縦画面に切り替えられる', async () => {
    const r = await ev(() => { const A = window.__jinchi.App; window.JINCHI_ORIENT = 'land'; A.orient = null; A.resize();
      return { w: A.w, h: A.h, rot: A.rot, land: document.body.classList.contains('land'), cw: document.getElementById('gl').width, p: A.toApp(100, 200), iw: innerWidth }; });
    assert(r.rot === 1 && r.w > r.h && r.land && r.cw > 0, 'rotated ' + JSON.stringify(r));
    assert(r.p[0] === 200 && r.p[1] === r.iw - 100, 'tap mapped ' + JSON.stringify(r.p));
    await page.waitForTimeout(500);
    await shot('12_rotated_landscape');
    const q = await ev(() => { const A = window.__jinchi.App; A.toggleOrient(); return { w: A.w, h: A.h, rot: A.rot, land: document.body.classList.contains('land'), lab: document.querySelector('.or-lab').textContent }; });
    assert(q.rot === 0 && q.w < q.h && !q.land && q.lab === '横画面', 'portrait ' + JSON.stringify(q));
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
