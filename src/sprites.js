// =====================================================================
// 兵士のスプライト（絵）。起動時に Canvas 2D で描いて 1 枚の絵（アトラス）にまとめる。
//   ・体は3Dの関節（腰・膝・肩・肘）で姿勢を決め、見る向きに合わせて投影してから
//     輪郭線と陰影のついた形で描く（8方向のうち5方向を描き、残りは左右反転）
//   ・県の色の部分（胴の縅・陣笠の紋・旗指物）は別の「マスク」に描き、表示時に色を乗せる
// =====================================================================
const SPR = {
  FW: 96, FH: 128,          // 1コマの大きさ（px）
  COLS: 21,                 // アトラスの横のコマ数（2048 / 96）
  VIEWS: 5,                 // 0:正面 1:斜め前 2:横 3:斜め後ろ 4:背中（右向き。左向きは反転）
  POSES: ['idle', 'walk0', 'walk1', 'walk2', 'walk3', 'atk0', 'atk1', 'dead'],
  KINDS: 4,                 // 0:鉄砲 1:鉄砲+旗 2:槍 3:槍+旗
  FOOT: 118,                // 足元の y（px）
  HEIGHT: 100,              // 体の高さ（px）
};
SPR.index = (kind, view, pose) => (kind * SPR.VIEWS + view) * SPR.POSES.length + pose;
SPR.count = SPR.KINDS * SPR.VIEWS * SPR.POSES.length;

class SoldierPainter {
  constructor() {
    const rows = Math.ceil(SPR.count / SPR.COLS);
    this.w = 2048;
    this.h = 1;
    while (this.h < rows * SPR.FH) this.h *= 2;
    this.color = document.createElement('canvas');
    this.mask = document.createElement('canvas');
    for (const c of [this.color, this.mask]) { c.width = this.w; c.height = this.h; }
  }
  /** すべてのコマを描く */
  paint() {
    const cc = this.color.getContext('2d'), mc = this.mask.getContext('2d');
    mc.fillStyle = '#000'; mc.fillRect(0, 0, this.w, this.h);
    for (let kind = 0; kind < SPR.KINDS; kind++) {
      for (let view = 0; view < SPR.VIEWS; view++) {
        for (let pose = 0; pose < SPR.POSES.length; pose++) {
          const k = SPR.index(kind, view, pose);
          const ox = (k % SPR.COLS) * SPR.FW, oy = Math.floor(k / SPR.COLS) * SPR.FH;
          for (const [ctx, mode] of [[cc, 'color'], [mc, 'mask']]) {
            ctx.save();
            ctx.beginPath(); ctx.rect(ox, oy, SPR.FW, SPR.FH); ctx.clip();
            ctx.translate(ox + SPR.FW / 2, oy + SPR.FOOT);
            this.drawFigure(ctx, mode, kind, view, SPR.POSES[pose]);
            ctx.restore();
          }
        }
      }
    }
    return this;
  }
  /** 関節の角度（ラジアン）。thigh/shin は前へ振ると正、arm は前へ上げると正 */
  pose(name, gun) {
    const p = { lean: 0, lt: 0, ls: 0.06, rt: 0, rs: 0.06, lu: 0.08, lf: 0.25, ru: 0.08, rf: 0.25, weapon: 'carry', crouch: 0 };
    if (name.startsWith('walk')) {
      const ph = (+name.slice(4)) * Math.PI / 2 + 0.6;
      const s = Math.sin(ph);
      p.lt = 0.42 * s; p.rt = -0.42 * s;
      p.ls = p.lt - Math.max(0, Math.sin(ph + 2.2)) * 0.85;
      p.rs = p.rt - Math.max(0, Math.sin(ph + Math.PI + 2.2)) * 0.85;
      p.lu = -0.38 * s; p.lf = p.lu + 0.35;
      p.ru = gun ? 0.15 : 0.38 * s; p.rf = p.ru + 0.4;
      p.lean = 0.06; p.crouch = Math.abs(Math.cos(ph)) * 1.5;
    } else if (name === 'atk0' || name === 'atk1') {
      p.lt = 0.32; p.ls = 0.1; p.rt = -0.28; p.rs = -0.4; p.crouch = 3;
      if (gun) {
        // 鉄砲を構える／撃つ（撃つときは少しのけぞる）
        p.lu = 1.25; p.lf = 1.55; p.ru = 0.55; p.rf = 1.5; p.weapon = 'aim';
        p.lean = name === 'atk1' ? -0.08 : 0.04;
      } else {
        // 槍を構える／突く
        const thrust = name === 'atk1';
        p.lu = thrust ? 1.3 : 0.9; p.lf = thrust ? 1.5 : 1.2; p.ru = thrust ? 1.0 : 0.5; p.rf = thrust ? 1.4 : 1.0;
        p.lean = thrust ? 0.22 : 0.08; p.weapon = thrust ? 'thrust' : 'guard';
      }
    }
    return p;
  }
  drawFigure(ctx, mode, kind, view, poseName) {
    const gun = kind < 2, flag = kind % 2 === 1;
    if (poseName === 'dead') {
      // 倒れた姿：横向きに寝かせて描く
      ctx.save();
      ctx.translate(-8, -6);
      ctx.rotate(-Math.PI / 2 + 0.08);
      ctx.translate(0, 34);
      this.drawFigure(ctx, mode, kind & 2, 2, 'idle');
      ctx.restore();
      return;
    }
    const P = this.pose(poseName, gun);
    const th = view * Math.PI / 4;               // 0:正面 … π:背中
    const ct = Math.cos(th), st = Math.sin(th);
    // 体の座標 (x:右, y:上, z:前) → 画面。見下ろしの角度ぶん、手前のものを少し下に
    const pr = (x, y, z) => {
      const sx = x * ct + z * st, d = -x * st + z * ct;
      return { x: sx, y: -y + d * 0.28, d };
    };
    const rot = (a, L) => [0, -Math.cos(a) * L, Math.sin(a) * L];   // 前後の振り
    const add = (p, v) => [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
    const lean = (p) => {                                              // 上半身の前傾（腰を中心に）
      const y = p[1] - 50, z = p[2];
      return [p[0], 50 + y * Math.cos(P.lean) - z * Math.sin(P.lean), z * Math.cos(P.lean) + y * Math.sin(P.lean)];
    };
    const drop = P.crouch;
    // ---- 関節の位置
    const hipY = 44 - drop;
    const hipL = [-7, hipY, 0], hipR = [7, hipY, 0];
    const kneeL = add(hipL, rot(P.lt, 21)), kneeR = add(hipR, rot(P.rt, 21));
    const ankL = add(kneeL, rot(P.ls, 20)), ankR = add(kneeR, rot(P.rs, 20));
    const up = (p) => lean([p[0], p[1] - drop, p[2]]);
    const neck = up([0, 77, 0]), chest = up([0, 69, 0]), waist = up([0, 48, 0]);
    const shL = up([-13, 73, 0]), shR = up([13, 73, 0]);
    const elL = add(shL, rot(P.lu, 15)), elR = add(shR, rot(P.ru, 15));
    const hdL = add(elL, rot(P.lf, 14)), hdR = add(elR, rot(P.rf, 14));
    const head = up([0, 86, 1]);
    // ---- 色（マスク描画のときは県の色の部分だけ白）
    const M = mode === 'mask';
    const C = {
      skin: ['#f0c79c', '#c98d5f'], cloth: ['#4a5272', '#262b40'], legging: ['#ece4d2', '#b7ab92'],
      armor: ['#e6e6e6', '#8a8a8a'], lacq: ['#5a3a28', '#2a170e'], sandal: ['#8a6a3c', '#4e3818'],
      wood: ['#8a5a32', '#4a2e16'], steel: ['#e8ecf0', '#7c848c'], hat: ['#4a3a30', '#1c140e'], flag: ['#f2f2f2', '#9a9a9a'],
    };
    const team = { armor: 1, flag: 1, mon: 1 };
    const parts = [];
    // 太さを持つ線（手足・武器）：tapered capsule
    const limb = (a, b, w1, w2, col) => {
      const A = pr(...a), B = pr(...b);
      parts.push({ d: (A.d + B.d) / 2, draw: () => this.capsule(ctx, A, B, w1, w2, C[col], M ? (team[col] ? '#fff' : '#000') : null) });
    };
    const poly = (pts, col, dz = 0, extra) => {
      const Q = pts.map((p) => pr(...p));
      const d = Q.reduce((s, q) => s + q.d, 0) / Q.length + dz;
      parts.push({ d, draw: () => { this.shape(ctx, Q, C[col], M ? (team[col] ? '#fff' : '#000') : null); if (extra && !M) extra(Q); } });
    };
    // ---- 脚（股引・脚絆・草鞋）
    for (const [hip, knee, ank, side] of [[hipL, kneeL, ankL, -1], [hipR, kneeR, ankR, 1]]) {
      limb(hip, knee, 10.5, 8.5, 'cloth');
      limb(knee, ank, 8, 6.4, 'legging');
      const toe = add(ank, [0, -1, 7]);
      limb([ank[0], ank[1] - 1.5, ank[2] - 2], toe, 5.6, 4.8, 'sandal');
    }
    // ---- 胴（胴丸：県の色の縅と黒漆の小札）・草摺
    const torsoW = (w, dd) => Math.abs(w * ct) + Math.abs(dd * st);
    const torso = () => {
      const a = pr(...waist), b = pr(...chest), n = pr(...neck);
      const wW = torsoW(12, 8), wC = torsoW(15, 8.5);
      const Q = [{ x: a.x - wW, y: a.y + 2 }, { x: a.x + wW, y: a.y + 2 }, { x: b.x + wC, y: b.y }, { x: n.x + wC * 0.75, y: n.y + 1 }, { x: n.x - wC * 0.75, y: n.y + 1 }, { x: b.x - wC, y: b.y }];
      this.shape(ctx, Q, C.armor, M ? '#fff' : null);
      if (!M) {
        // 小札の段（横の線）と縦の縫い目
        ctx.save();
        ctx.beginPath(); Q.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.clip();
        ctx.strokeStyle = 'rgba(40,24,14,.75)'; ctx.lineWidth = 1.3;
        for (let y = n.y + 4; y < a.y + 2; y += 4.2) { ctx.beginPath(); ctx.moveTo(-30, y); ctx.lineTo(30, y); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(255,230,160,.55)'; ctx.lineWidth = 0.7;
        for (let x = -12; x <= 12; x += 3) { ctx.beginPath(); ctx.moveTo(a.x + x * (wW / 12), a.y); ctx.lineTo(b.x + x * (wC / 12), n.y + 3); ctx.stroke(); }
        // 胸の金具と陰影
        ctx.fillStyle = 'rgba(20,10,4,.35)'; ctx.fillRect(Math.min(a.x, b.x) + wW * 0.25, n.y, wC, a.y - n.y + 3);
        ctx.restore();
      }
      // 草摺（腰の下の板）
      const Kq = [{ x: a.x - wW - 4, y: a.y + 17 }, { x: a.x + wW + 4, y: a.y + 17 }, { x: a.x + wW + 0.5, y: a.y }, { x: a.x - wW - 0.5, y: a.y }];
      this.shape(ctx, Kq, C.lacq, M ? '#000' : null);
      if (!M) { ctx.strokeStyle = 'rgba(230,190,110,.6)'; ctx.lineWidth = 0.8; for (let k = -1; k <= 1; k++) { ctx.beginPath(); ctx.moveTo(a.x + k * wW * 0.6, a.y + 1); ctx.lineTo(a.x + k * (wW + 3) * 0.7, a.y + 16); ctx.stroke(); }
        ctx.strokeStyle = 'rgba(230,190,110,.35)'; ctx.beginPath(); ctx.moveTo(a.x - wW - 1, a.y + 3); ctx.lineTo(a.x + wW + 1, a.y + 3); ctx.stroke(); }
    };
    parts.push({ d: pr(...chest).d, draw: torso });
    // ---- 腕（袖・籠手・手）
    for (const [sh, el, hd] of [[shL, elL, hdL], [shR, elR, hdR]]) {
      limb(sh, el, 8.5, 7, 'cloth');
      limb(el, hd, 7, 5.6, 'lacq');
      limb(hd, add(hd, [0, -2, 1]), 5.6, 4.8, 'skin');
    }
    // 肩の袖（大袖の代わりの小さな肩当て）
    for (const sh of [shL, shR]) poly([add(sh, [-5.5, 3, 0]), add(sh, [5.5, 3, 0]), add(sh, [6.5, -9, 0]), add(sh, [-6.5, -9, 0])], 'armor', 0.5);
    // ---- 頭（顔・陣笠と紋）
    parts.push({ d: pr(...head).d + 0.2, draw: () => {
      const h = pr(...head);
      if (!M) {
        const g = ctx.createRadialGradient(h.x - 2, h.y - 2, 1, h.x, h.y, 7.5);
        g.addColorStop(0, C.skin[0]); g.addColorStop(1, C.skin[1]);
        ctx.fillStyle = g; ctx.strokeStyle = 'rgba(30,18,10,.9)'; ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.ellipse(h.x, h.y, 7.2, 8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // 顔（こちらを向いているときだけ）
        if (ct > 0.2) {
          const fx = h.x + st * 2.5;
          ctx.fillStyle = '#2a1a10';
          ctx.fillRect(fx - 2.6 * ct, h.y + 0.5, 1.4, 1.2); ctx.fillRect(fx + 1.4 * ct, h.y + 0.5, 1.4, 1.2);
          ctx.strokeStyle = 'rgba(80,40,20,.6)'; ctx.lineWidth = 0.8;
          ctx.beginPath(); ctx.moveTo(fx - 1.5, h.y + 4.2); ctx.lineTo(fx + 1.5, h.y + 4.2); ctx.stroke();
        } else if (Math.abs(st) > 0.5 && ct > -0.5) {
          ctx.fillStyle = '#2a1a10'; ctx.fillRect(h.x + 3 * Math.sign(st), h.y + 0.5, 1.3, 1.2);
        }
        // 顎紐
        ctx.strokeStyle = 'rgba(60,30,15,.8)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(h.x - 5, h.y - 3); ctx.quadraticCurveTo(h.x, h.y + 9, h.x + 5, h.y - 3); ctx.stroke();
      } else { ctx.fillStyle = '#000'; ctx.beginPath(); ctx.ellipse(h.x, h.y, 7.2, 8, 0, 0, Math.PI * 2); ctx.fill(); }
      // 陣笠：つばの楕円と低い円錐
      const hy = h.y - 5, rw = 17, rh = 5.2;
      if (!M) {
        const g = ctx.createLinearGradient(h.x - rw, hy - 8, h.x + rw, hy + 3);
        g.addColorStop(0, C.hat[0]); g.addColorStop(1, C.hat[1]);
        ctx.fillStyle = g; ctx.strokeStyle = 'rgba(10,6,3,.95)'; ctx.lineWidth = 1.1;
        ctx.beginPath(); ctx.moveTo(h.x - rw, hy); ctx.quadraticCurveTo(h.x, hy - 13, h.x + rw, hy); ctx.ellipse(h.x, hy, rw, rh, 0, 0, Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,240,210,.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(h.x - rw * 0.6, hy - 3); ctx.quadraticCurveTo(h.x - 2, hy - 9, h.x + 2, hy - 8.5); ctx.stroke();
      } else { ctx.fillStyle = '#000'; ctx.beginPath(); ctx.moveTo(h.x - rw, hy); ctx.quadraticCurveTo(h.x, hy - 13, h.x + rw, hy); ctx.ellipse(h.x, hy, rw, rh, 0, 0, Math.PI); ctx.fill(); }
      // 紋（県の色）
      if (ct > -0.3) { ctx.fillStyle = M ? '#fff' : '#d8d8d8'; ctx.beginPath(); ctx.ellipse(h.x + st * 3, hy - 4, 2.6 * Math.max(0.4, Math.abs(ct)), 2.2, 0, 0, Math.PI * 2); ctx.fill(); }
    } });
    // ---- 武器
    const R = hdR, Lh = hdL;
    if (gun) {
      let a, b;
      if (P.weapon === 'aim') { a = add(R, [0, 1, -8]); b = add(Lh, [0, 0.5, 26]); }
      else { a = add(R, [0, -2, -10]); b = add(R, [0, 40, -12]); }   // 肩に担ぐ
      limb(a, b, 3.6, 2.6, 'wood');
      const mid = [a[0] + (b[0] - a[0]) * 0.55, a[1] + (b[1] - a[1]) * 0.55, a[2] + (b[2] - a[2]) * 0.55];
      limb(mid, add(b, [(b[0] - a[0]) * 0.08, (b[1] - a[1]) * 0.08, (b[2] - a[2]) * 0.08]), 1.8, 1.6, 'steel');
    } else {
      let a, b;
      if (P.weapon === 'thrust') { a = add(R, [0, -2, -22]); b = add(R, [0, 6, 60]); }
      else if (P.weapon === 'guard') { a = add(R, [0, -14, -12]); b = add(R, [0, 48, 36]); }
      else { a = add(R, [1, -40, 1]); b = add(R, [1, 60, 4]); }      // 立てて持つ
      limb(a, b, 2.4, 2.2, 'wood');
      const L = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L, (b[2] - a[2]) / L];
      limb(b, add(b, [u[0] * 10, u[1] * 10, u[2] * 10]), 2.8, 0.6, 'steel');
    }
    // ---- 旗指物（背中）
    if (flag) {
      const base = up([0, 66, -6]), top = up([0, 124, -7]);
      limb(base, top, 1.8, 1.5, 'wood');
      poly([up([-0.5, 120, -7]), up([-0.5, 92, -7]), up([-12, 92, -7]), up([-12, 120, -7])], 'flag', -0.5, (Q) => {
        ctx.strokeStyle = 'rgba(0,0,0,.18)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo((Q[0].x + Q[3].x) / 2, Q[0].y + 3); ctx.lineTo((Q[1].x + Q[2].x) / 2, Q[1].y - 3); ctx.stroke();
      });
    }
    // 奥から順に描く
    parts.sort((a, b) => a.d - b.d);
    for (const p of parts) p.draw();
  }
  /** 太さが変わる棒（輪郭線と陰影） */
  capsule(ctx, A, B, w1, w2, col, maskColor) {
    const dx = B.x - A.x, dy = B.y - A.y, L = Math.hypot(dx, dy) || 0.01;
    const nx = -dy / L, ny = dx / L, r1 = w1 / 2, r2 = w2 / 2;
    const ang = Math.atan2(dy, dx);
    ctx.beginPath();
    ctx.moveTo(A.x + nx * r1, A.y + ny * r1);
    ctx.lineTo(B.x + nx * r2, B.y + ny * r2);
    ctx.arc(B.x, B.y, r2, ang + Math.PI / 2, ang - Math.PI / 2, true);
    ctx.lineTo(A.x - nx * r1, A.y - ny * r1);
    ctx.arc(A.x, A.y, r1, ang - Math.PI / 2, ang + Math.PI / 2, true);
    ctx.closePath();
    if (maskColor) { ctx.fillStyle = maskColor; ctx.fill(); return; }
    // 左上からの光：棒の左側を明るく
    const g = ctx.createLinearGradient(A.x - nx * r1 * Math.sign(nx || 1), A.y, A.x + nx * r1 * Math.sign(nx || 1), A.y + 0.01);
    g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(28,18,10,.9)'; ctx.lineWidth = 1.1;
    ctx.fill(); ctx.stroke();
  }
  /** 多角形（輪郭線と上から下への陰影） */
  shape(ctx, Q, col, maskColor) {
    ctx.beginPath();
    Q.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    if (maskColor) { ctx.fillStyle = maskColor; ctx.fill(); return; }
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const q of Q) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, col[0]); g.addColorStop(1, col[1]);
    ctx.fillStyle = g;
    ctx.strokeStyle = 'rgba(28,18,10,.9)'; ctx.lineWidth = 1.1;
    ctx.fill(); ctx.stroke();
  }
}

// =====================================================================
// 地面の質感：筆で描いたような草の筋の絵（くり返し貼れる 512×512）を起動時に描く。
//   grass：短く刈られた緑の草地 / dry：黄金色の枯れ草（長めの筋）
// =====================================================================
class GroundPainter {
  constructor(size = 512) { this.size = size; }
  paint() {
    // 鮮やかな黄緑の草（明るい黄色の筋と濃い緑の筋）
    this.grass = this.paintOne([[132, 172, 40], [104, 150, 30], [176, 196, 62], [200, 204, 80], [80, 124, 26], [150, 176, 44], [214, 210, 96]], [134, 170, 44], 9, 18000, 1.5);
    // 黄金色の枯れ草（橙がかった筋）
    this.dry = this.paintOne([[218, 170, 56], [236, 194, 78], [196, 138, 40], [172, 124, 38], [244, 214, 112], [190, 160, 52], [160, 150, 50]], [212, 166, 58], 14, 16000, 1.7);
    return this;
  }
  paintOne(palette, base, len, count, width) {
    const N = this.size, cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = `rgb(${base})`;
    ctx.fillRect(0, 0, N, N);
    // ゆるいむら（大きな淡い円）
    let seed = palette[0][0] * 7 + len;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let k = 0; k < 60; k++) {
      const c = palette[(rnd() * palette.length) | 0], x = rnd() * N, y = rnd() * N, r = 20 + rnd() * 60;
      for (const [ox, oy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${c},0.35)`); g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g; ctx.fillRect(x + ox - r, y + oy - r, r * 2, r * 2);
      }
    }
    // 草の筋：だいたい同じ向き（右上がり）の短いストローク。端はつながるように折り返して描く
    ctx.lineCap = 'round';
    for (let k = 0; k < count; k++) {
      const c = palette[(rnd() * palette.length) | 0];
      const x = rnd() * N, y = rnd() * N, L = len * (0.5 + rnd());
      const a = -1.05 + (rnd() - 0.5) * 0.7;
      const dx = Math.cos(a) * L, dy = Math.sin(a) * L;
      const light = rnd() < 0.22 ? 45 : rnd() < 0.3 ? -40 : 0;
      ctx.strokeStyle = `rgba(${c[0] + light},${c[1] + light},${c[2] + light * 0.4},${0.45 + rnd() * 0.5})`;
      ctx.lineWidth = width * (0.6 + rnd() * 0.8);
      for (const [ox, oy] of [[0, 0], [N, 0], [-N, 0], [0, N], [0, -N]]) {
        if (x + ox + Math.max(0, dx) < -2 || x + ox + Math.min(0, dx) > N + 2 || y + oy + Math.max(0, dy) < -2 || y + oy + Math.min(0, dy) > N + 2) continue;
        ctx.beginPath(); ctx.moveTo(x + ox, y + oy); ctx.lineTo(x + ox + dx, y + oy + dy); ctx.stroke();
      }
    }
    return cv;
  }
}
