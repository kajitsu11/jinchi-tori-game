// ブラウザ用の src/core.js・src/rts_sim.js を、そのまま Node で読み込む（ルールはブラウザ版と同じものを使う）
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..');

function loadEngine() {
  const sandbox = {
    console, performance, Math, Date,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    setTimeout: (f) => f(),
    // 標高PNGはサーバーでは使わない（描画だけに使う）ので、空の画像として読む
    document: { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: (x, y, w, h) => ({ data: new Uint8Array(w * h * 4) }) }) }) },
    Image: class { set src(v) { setTimeout(() => this.onload()); } },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  const src = ['src/core.js', 'src/rts_sim.js'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n') +
    '\nglobalThis.__x = { CONFIG, BUILDINGS, MapData, Sim, RES_KEYS };';
  vm.runInContext(src, sandbox, { filename: 'engine.js' });
  return sandbox.__x;
}

/** 元の地図（data/mapdata.json）を読み、S 倍に細かくした地図を作る */
async function loadMaps(E, S) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mapdata.json'), 'utf8'));
  const coarse = new E.MapData(raw);
  await coarse.decode(() => {});
  const fine = S > 1 ? E.MapData.upscale(coarse, S) : coarse;
  return { coarse, fine };
}

module.exports = { loadEngine, loadMaps, ROOT };
