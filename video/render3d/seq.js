// 3D素材の連番PNG(透過)を書き出す: node seq.js <outdir>
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname, out = process.argv[2] || path.join(root, 'out');
const only = process.argv[3];
const srv = http.createServer((q, r) => { const f = path.join(root, decodeURIComponent(q.url.split('?')[0])); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'Content-Type': f.endsWith('.js') ? 'text/javascript' : f.endsWith('.html') ? 'text/html' : 'application/octet-stream' }); r.end(d); }); }).listen(8765);
const JOBS = [  // name, w, h, frames, seconds(=t range)
  ['dna', 560, 800, 120, 2 * Math.PI / 0.9],
  ['honeycomb', 1100, 700, 90, 6],
  ['bars', 1000, 640, 90, 3.0],
  ['chromo2', 640, 300, 60, 2 * Math.PI / 1.2],
  ['chromo1', 640, 300, 60, 2 * Math.PI / 1.2],
];
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const [name, w, h, n, secs] of JOBS) {
    if (only && only !== name) continue;
    const dir = path.join(out, name); fs.mkdirSync(dir, { recursive: true });
    const p = await b.newPage({ viewport: { width: w, height: h } });
    p.on('pageerror', e => console.log('err:', e.message));
    await p.goto(`http://127.0.0.1:8765/index.html?w=${w}&h=${h}`); await p.waitForFunction(() => window.ready);
    const meta = [];
    for (let i = 0; i < n; i++) {
      const t = name === 'bars' ? i / (n - 1) * secs : i / n * secs;
      const r = await p.evaluate(([nm, t]) => window.render(nm, t), [name, t]);
      meta.push(r);
      await p.locator('canvas').screenshot({ path: path.join(dir, String(i).padStart(4, '0') + '.png'), omitBackground: true });
    }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ frames: n, seconds: secs, loop: name !== 'bars', data: meta }));
    console.log('done', name, n); await p.close();
  }
  await b.close(); srv.close();
})();
