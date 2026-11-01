// シーズンの保存と読み込み（サーバーを再起動しても続きから）
//   ファイル：[4バイト：JSONの長さ][JSON（拠点・建物・兵士・資源・参加者など）][持ち主][拠点の番号][拠点までの距離] を gzip
//   兵士の経路は保存しない（読み込んだあと、それぞれ考え直して歩き出す）
const fs = require('fs');
const zlib = require('zlib');

const SKIP_UNIT = new Set(['path', 'pi', 'dest', 'hitB', 'k']);

function snapshot(season) {
  const g = season.sim;
  const state = {
    version: 1, W: g.map.W, H: g.map.H, N: g.map.N, nodes: g.nodes.length,
    time: g.time, incomeT: g.incomeT, counts: Array.from(g.counts), pop: Array.from(g.pop), nodeCount: Array.from(g.nodeCount),
    parts: Array.from(g.parts), humansIn: Array.from(g.humansIn), res: g.res, aiBuildAt: Array.from(g.aiBuildAt), rally: g.rally,
    plans: g.plans, eliminated: [...g.eliminated], recent: g.recent, stats: g.stats, bseq: g.bseq, useq: g.useq, tickNo: g.tickNo, over: g.over,
    humans: [...g.humans.values()], accounts: [...season.accounts.values()], seasonNo: season.seasonNo,
    nodeList: g.nodes,
    buildings: g.buildings.map((b) => ({ ...b })),
    units: g.units.filter((u) => u.alive).map((u) => { const o = {}; for (const k in u) if (!SKIP_UNIT.has(k)) o[k] = u[k]; return o; }),
  };
  const json = Buffer.from(JSON.stringify(state));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(json.length, 0);
  // 大きな配列はコピーしてから、別のスレッドで圧縮する（その間もゲームは進む）
  return Buffer.concat([head, json, Buffer.from(g.owner), Buffer.from(g.nodeOf.buffer.slice(0)), Buffer.from(g.nodeDist)]);
}

function save(season, file) {
  const t0 = Date.now();
  const raw = snapshot(season);
  return new Promise((resolve, reject) => {
    zlib.gzip(raw, { level: 3 }, (err, out) => {
      if (err) return reject(err);
      fs.writeFile(file + '.tmp', out, (e2) => {
        if (e2) return reject(e2);
        fs.rename(file + '.tmp', file, (e3) => (e3 ? reject(e3) : resolve({ ms: Date.now() - t0, bytes: out.length })));
      });
    });
  });
}

/** 保存したシーズンを Sim に戻す。地図が違えば読み込まない（false） */
function load(season, file) {
  if (!fs.existsSync(file)) return false;
  const raw = zlib.gunzipSync(fs.readFileSync(file));
  const len = raw.readUInt32LE(0);
  const st = JSON.parse(raw.subarray(4, 4 + len).toString());
  const g = season.sim, N = g.map.N;
  if (st.version !== 1 || st.W !== g.map.W || st.H !== g.map.H || st.N !== N) { console.log('save file is for another map; ignored'); return false; }
  let o = 4 + len;
  g.owner.set(raw.subarray(o, o + N)); o += N;
  g.nodeOf.set(new Int16Array(raw.buffer.slice(raw.byteOffset + o, raw.byteOffset + o + N * 2))); o += N * 2;
  g.nodeDist.set(raw.subarray(o, o + N));
  g.time = st.time; g.incomeT = st.incomeT; g.acc = 0;
  for (const k of ['counts', 'pop', 'nodeCount', 'parts', 'humansIn', 'aiBuildAt']) g[k].set(st[k]);
  g.res = st.res; g.rally = st.rally; g.plans = st.plans; g.eliminated = new Set(st.eliminated); g.recent = st.recent;
  g.stats = st.stats; g.bseq = st.bseq; g.useq = st.useq; g.tickNo = st.tickNo; g.over = st.over;
  g.humans = new Map(st.humans.map((h) => [h.w, h]));
  season.accounts = new Map(st.accounts.map((a) => [a.token, a]));
  season.seasonNo = st.seasonNo;
  g.nodes = st.nodeList;
  g.rebuildNodeCells();
  g.computeNodeAdj();
  g.buildings = st.buildings;
  g.bgrid = new Map();
  for (const b of g.buildings) { const k = g.bkey(b.x, b.y); if (!g.bgrid.has(k)) g.bgrid.set(k, []); g.bgrid.get(k).push(b); }
  g.units = st.units.map((u) => ({ ...u, path: null, pi: 0, dest: null, hitB: null, goalNode: -1, thinkAt: g.time + Math.random() * 3 }));
  return true;
}

module.exports = { save, load };
