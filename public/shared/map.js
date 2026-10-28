// マップ生成（ブラウザとサーバーの両方で使う。同じ seed なら同じマップになる）
(function (root) {
  'use strict';

  function mulberry32(a) {
    return () => {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function neighbors(i, W, H) {
    const x = i % W, N = W * H, out = [];
    if (x > 0) out.push(i - 1);
    if (x < W - 1) out.push(i + 1);
    if (i >= W) out.push(i - W);
    if (i < N - W) out.push(i + W);
    return out;
  }

  const TOWN_A = ['桜', '松', '竹', '梅', '青', '白', '赤', '黒', '大', '小', '高', '長', '北', '南', '東', '西', '新', '古',
    '森', '石', '鳥', '鹿', '花', '月', '星', '金', '銀', '風', '雪', '霧', '虹', '柿', '栗', '蛍', '若', '若葉', '朝', '夕',
    '春', '夏', '秋', '冬', '岩', '杉', '藤', '菊', '萩', '椿', '泉', '滝', '浅', '深', '平', '中', '上', '下', '玉', '宝'];
  const TOWN_B = ['ヶ丘', '見', '原', '沢', '田', '島', '崎', '浦', '野', '谷', '瀬', '岡', '宮', '津', '浜', '山', '川', '台', '里', '根',
    '木', '尾', '井', '坂', '橋', '池', '江', '室', '倉', '城'];
  const TOWN_C = ['市', '町', '町', '村'];
  const TOWN_D = ['東', '西', '南', '北', '中', '新'];
  function townName(r, used) {
    for (let k = 0; ; k++) {
      let n = TOWN_A[Math.floor(r() * TOWN_A.length)] + TOWN_B[Math.floor(r() * TOWN_B.length)] + TOWN_C[Math.floor(r() * TOWN_C.length)];
      if (k > 30) n = TOWN_D[Math.floor(r() * TOWN_D.length)] + n;   // 大きいマップで名前が足りないとき
      if (k > 200) n = n.slice(0, -1) + k + n.slice(-1);
      if (used.has(n)) continue;
      used.add(n);
      return n;
    }
  }

  function generate(seed, W, H) {
    const N = W * H, r = mulberry32(seed);
    const tx = (i) => i % W, ty = (i) => (i / W) | 0;
    const makeNoise = (cell) => {
      const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
      const g = new Float32Array(gw * gh);
      for (let k = 0; k < g.length; k++) g[k] = r();
      return (x, y) => {
        const fx = x / cell, fy = y / cell, ix = fx | 0, iy = fy | 0;
        const ax = fx - ix, ay = fy - iy;
        const sx = ax * ax * (3 - 2 * ax), sy = ay * ay * (3 - 2 * ay);
        const a = g[iy * gw + ix], b = g[iy * gw + ix + 1], c = g[(iy + 1) * gw + ix], d = g[(iy + 1) * gw + ix + 1];
        return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
      };
    };
    // マップの大きさに合わせて、大陸の形から海岸線の細かさまで何段階か重ねる
    const oct = [];
    let wsum = 0;
    for (let c = Math.max(W, H) / 4.3, w = 1; c >= 1.5; c /= 2, w *= 0.5) { oct.push([makeNoise(c), w]); wsum += w; }
    const h = new Float32Array(N);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let v = 0;
      for (const [f, w] of oct) v += f(x, y) * w;
      v /= wsum;
      const dx = (x / (W - 1) - 0.5) * 2, dy = (y / (H - 1) - 0.5) * 2;
      v -= (dx * dx + dy * dy) * 0.35;
      h[y * W + x] = v;
    }
    const sorted = Array.from(h).sort((a, b) => a - b);
    const thr = sorted[Math.floor(N * 0.42)], top = sorted[N - 1];
    const terrain = new Uint8Array(N);
    for (let i = 0; i < N; i++) terrain[i] = h[i] > thr ? 1 : 0;

    // 最大の大陸だけを残す
    const comp = new Int32Array(N).fill(-1);
    let best = -1, bestSize = 0, cid = 0;
    for (let i = 0; i < N; i++) {
      if (!terrain[i] || comp[i] >= 0) continue;
      const stack = [i]; comp[i] = cid; let size = 0;
      while (stack.length) {
        const j = stack.pop(); size++;
        for (const k of neighbors(j, W, H)) if (terrain[k] && comp[k] < 0) { comp[k] = cid; stack.push(k); }
      }
      if (size > bestSize) { bestSize = size; best = cid; }
      cid++;
    }
    let landCount = 0;
    const elev = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      if (terrain[i] && comp[i] !== best) terrain[i] = 0;
      if (terrain[i]) { landCount++; elev[i] = (h[i] - thr) / (top - thr); }
      else elev[i] = Math.min(1, (thr - h[i]) / 0.25);
    }

    // 町：格子ごとに中心点を1つ置き（ずらし入り）、座標を少し歪ませて一番近い中心に割り当てる
    const area = Math.min(150, Math.max(9, landCount / 2000));   // 町1つのおよそのマス数
    const G = Math.sqrt(area), gw = Math.ceil(W / G), gh = Math.ceil(H / G);
    const warp = G * 0.9, warpX = makeNoise(G * 1.2), warpY = makeNoise(G * 1.2);
    const provinces = [], seedAt = new Int32Array(gw * gh).fill(-1), used = new Set();
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x = Math.min(W - 1, Math.floor((gx + 0.15 + r() * 0.7) * G)), y = Math.min(H - 1, Math.floor((gy + 0.15 + r() * 0.7) * G));
      if (!terrain[y * W + x]) continue;
      seedAt[gy * gw + gx] = provinces.length;
      provinces.push({ x, y, name: townName(r, used), land: 0, sx: 0, sy: 0 });
    }
    const prov = new Int32Array(N).fill(-1);
    let peak = -1;
    for (let i = 0; i < N; i++) {
      if (!terrain[i]) continue;
      const x = tx(i), y = ty(i);
      const wx = x + (warpX(x, y) - 0.5) * warp, wy = y + (warpY(x, y) - 0.5) * warp;
      const cgx = Math.floor(wx / G), cgy = Math.floor(wy / G);
      let bk = -1, bd = Infinity;
      for (let ry = 1; bk < 0 && ry <= 4; ry++) {      // 近くに中心がなければ探す範囲を広げる
        for (let gy = cgy - ry; gy <= cgy + ry; gy++) for (let gx = cgx - ry; gx <= cgx + ry; gx++) {
          if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) continue;
          const k = seedAt[gy * gw + gx];
          if (k < 0) continue;
          const d = (provinces[k].x - wx) ** 2 + (provinces[k].y - wy) ** 2;
          if (d < bd) { bd = d; bk = k; }
        }
      }
      if (bk < 0) { bk = provinces.length; provinces.push({ x, y, name: townName(r, used), land: 0, sx: 0, sy: 0 }); }
      prov[i] = bk;
      const P = provinces[bk];
      P.land++; P.sx += x; P.sy += y;
      if (peak < 0 || elev[i] > elev[peak]) peak = i;
    }
    for (const P of provinces) if (P.land) { P.lx = P.sx / P.land + 0.5; P.ly = P.sy / P.land + 0.5; }
    return { W, H, N, terrain, elev, prov, provinces, peak, landCount };
  }

  root.JintoriMap = { generate, neighbors, mulberry32 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
