// シーズン（7日間）を画面なしで高速に回して、バランスを確かめる
//   node tools/season_sim.js [日数=7] [刻み秒=2] [seed=1]   （SCALE=3 でオンライン版の細かい地図）
// 出力：6時間ごとの 1位の県と割合・脱落数・兵士数・建物数・占領回数
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const days = +(process.argv[2] || 7), dt = +(process.argv[3] || 2), seed = +(process.argv[4] || 1);
const report = +(process.env.REPORT_H || 6) * 3600;

const sandbox = {
  console, atob: (s) => Buffer.from(s, 'base64').toString('binary'), performance, Math, Date,
  setTimeout: (f) => f(), document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }) }) }) },
  Image: class { set src(v) { setTimeout(() => this.onload()); } },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const src = fs.readFileSync(path.join(ROOT, 'src/core.js'), 'utf8') + '\n' + fs.readFileSync(path.join(ROOT, 'src/rts_sim.js'), 'utf8') +
  '\nglobalThis.__x = { CONFIG, MapData, Sim };';
vm.runInContext(src, sandbox);
const { CONFIG, MapData, Sim } = sandbox.__x;
if (process.env.OVERRIDE) Object.assign(CONFIG, JSON.parse(process.env.OVERRIDE));

(async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mapdata.json'), 'utf8'));
  let map = new MapData(raw);
  await map.decode(() => {});
  if (+process.env.SCALE > 1) map = MapData.upscale(map, +process.env.SCALE);   // オンライン版の細かい地図
  const me = +(process.env.ME || 13);
  const g = new Sim(map, me, seed);
  const end = days * 86400;
  const t0 = Date.now();
  let next = report;
  const line = () => {
    const r = g.ranking();
    const lead = r[0];
    const pct = (p) => (g.pop[p] / g.popTotal * 100).toFixed(1) + '%人口/' + (g.counts[p] / map.landCells * 100).toFixed(1);
    const d = Math.floor(g.time / 86400), h = Math.floor((g.time % 86400) / 3600);
    console.log(`D${d + 1} ${String(h).padStart(2, '0')}h | 1位 ${map.prefs[lead].short} ${pct(lead)}% 2位 ${map.prefs[r[1]].short} ${pct(r[1])}% 3位 ${map.prefs[r[2]].short} ${pct(r[2])}% | ` +
      `脱落 ${g.eliminated.size} | 自県(${map.prefs[me].short}) ${pct(me)}% ${g.rankOf(me)}位 | 兵 ${g.units.length} 建物 ${g.buildings.length} 拠点 ${g.nodes.length} | 占領 ${g.stats.captures} | ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  };
  while (g.time < end && !g.over) {
    g.step(dt);
    if (g.time >= next) { line(); next += report; }
  }
  line();
  console.log('over:', JSON.stringify(g.over), 'stats:', JSON.stringify(g.stats));
})();
