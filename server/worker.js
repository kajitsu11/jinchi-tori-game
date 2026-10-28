// 陣地取り大戦 オンライン版サーバー（Cloudflare Workers + Durable Object）
//
// ・マップの正本はサーバー（GameRoom）だけが持ち、行動の判定はすべてここで行う
// ・1日1マスは「アカウントごと」と「回線（IP）ごと」の両方で数える
// ・IP は生のまま保存せず、秘密の値（IP_SALT）と混ぜたハッシュで記録する
// ・1万人規模を想定：地図は最初に1回だけ圧縮して送り、あとは変わったマスだけを1秒ごとにまとめて配信する
import '../public/shared/map.js';

const { generate, neighbors } = globalThis.JintoriMap;

const W = 440, H = 560;              // 約25万マス（陸地は約14万マス）
const NONE = 255;                    // owner：だれのものでもない
const CHUNK = 32768;                 // 保存するときの区切り（マス数）
const SEASON_DAYS = 100;
const SAM_RANGE = 12;
const SILO_RELOAD = 2;
const SAM_RELOAD = 3;
const LOG_KEEP = 80;
const NATIONS = [
  { name: 'ねこ県', color: '#f6d55c' }, { name: 'いぬ市', color: '#ef8fd6' }, { name: 'たぬき町', color: '#6cc36a' },
  { name: 'きつね村', color: '#f39a5b' }, { name: 'うさぎ王国', color: '#4f8fe0' }, { name: 'くま共和国', color: '#8a6cf0' },
];
const BUILD = {
  city: { name: '都市', base: 50, scale: 1.0 },
  silo: { name: 'ミサイル基地', base: 120, scale: 1.0 },
  sam:  { name: '迎撃基地', base: 80, scale: 0.6 },
};
const NUKE = {
  atom:  { name: '原子爆弾', cost: 150, r: 4, fallout: 3 },
  hydro: { name: '水素爆弾', cost: 400, r: 9, fallout: 5 },
  mirv:  { name: 'MIRV', cost: 900, r: 3, fallout: 3, warheads: 6 },
};

// IP ごとの制限（wrangler.toml の [vars] で上書きできる）
function limits(env) {
  const n = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
  return {
    perMinute: n(env.RATE_LIMIT_PER_MIN, 60),              // 1分あたりのリクエスト数
    accountsPerDay: n(env.MAX_ACCOUNTS_PER_IP_PER_DAY, 2), // 1日に作れるアカウント数
    actionsPerDay: n(env.MAX_ACTIONS_PER_IP_PER_DAY, 2),   // 1日の行動（マス）数
    sockets: n(env.MAX_SOCKETS_PER_IP, 6),                 // 同時接続数（タブ数）
  };
}

// ===== 日付（日本時間0時で切り替え） =====
const jstDate = (t = Date.now()) => new Date(t + 9 * 3600e3).toISOString().slice(0, 10);
const nextDate = (d) => new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10);
const prevDate = (d) => new Date(Date.parse(d + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
const diffDays = (a, b) => Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 864e5);

// ===== ユーティリティ =====
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const fail = (message, status = 400) => json({ error: message }, status);
async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 管理画面に出す、一部を隠した IP（203.0.113.xxx / 2001:db8:1:2::xxxx）
function maskIp(ip) {
  if (ip.includes('.')) return ip.split('.').slice(0, 3).join('.') + '.xxx';
  if (ip.includes(':')) return ip.split(':').slice(0, 4).join(':') + '::xxxx';
  return ip;
}
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f\u007f<>&"'`]/g, '').trim().slice(0, 10);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
function clientIp(req, env) {
  // ローカル開発（wrangler dev）でだけ、テスト用ヘッダーで IP を切り替えられる
  if (env.DEV === '1' && req.headers.get('X-Test-IP')) return req.headers.get('X-Test-IP');
  return req.headers.get('CF-Connecting-IP') || 'unknown';
}

// ===== Worker の入口 =====
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const origin = req.headers.get('Origin');
    const allowed = env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN ? origin : null;
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: allowed ? {
          'Access-Control-Allow-Origin': allowed,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'content-type, x-player-token, x-admin-key',
          'Access-Control-Expose-Headers': 'x-seq',
          'Access-Control-Max-Age': '86400',
        } : {},
      });
    }
    const stub = env.GAME.get(env.GAME.idFromName('main'));
    const res = await stub.fetch(req);
    if (res.status === 101 || !allowed) return res;
    const out = new Response(res.body, res);
    out.headers.set('Access-Control-Allow-Origin', allowed);
    out.headers.set('Access-Control-Expose-Headers', 'x-seq');
    return out;
  },
};

// ===== ゲームの部屋（全員が同じ1部屋） =====
export class GameRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.limits = limits(env);
    this.rate = new Map();          // ipHash -> { start, count }（メモリ上だけ）
    this.meta = null;               // 地図以外の状態（国・建物・ログ・日付）
    this.owner = null;              // Uint8Array：マスの持ち主（NONE＝無人）
    this.flags = null;              // Uint8Array：bit0＝盾、残り＝汚染の残り日数
    this.dirtyChunks = new Set();
    this.pending = new Set();       // まだ配信していない変わったマス
    this.pendingLogs = [];
    this.pendingEvents = [];
    this.metaChanged = false;
    this.broadcastTimer = 0;
  }

  // ===== 読み込み・保存 =====
  async load() {
    if (this.meta) return;
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.meta) return;
      const meta = await this.ctx.storage.get('meta');
      if (meta) {
        this.meta = meta;
        this.map = generate(meta.seed, meta.W, meta.H);
        const n = meta.W * meta.H, chunks = Math.ceil(n / CHUNK);
        const keys = [];
        for (let k = 0; k < chunks; k++) keys.push('o:' + k, 'f:' + k);
        const got = await this.ctx.storage.get(keys);
        this.owner = new Uint8Array(n).fill(NONE);
        this.flags = new Uint8Array(n);
        for (let k = 0; k < chunks; k++) {
          const o = got.get('o:' + k), f = got.get('f:' + k);
          if (o) this.owner.set(o, k * CHUNK);
          if (f) this.flags.set(f, k * CHUNK);
        }
        this.recount();
      } else {
        this.startSeason(1);
        await this.flush(true);
      }
    });
  }

  startSeason(no) {
    const seed = (Math.random() * 1e9) | 0;
    this.map = generate(seed, W, H);
    const today = jstDate();
    this.meta = {
      seasonNo: no, seed, W, H, seasonStart: today, lastDate: today, ended: false, winner: -1, seq: 0,
      buildings: [], logs: [], nations: NATIONS.map((n, id) => ({ id, ...n, capital: -1, members: 0 })),
    };
    this.owner = new Uint8Array(W * H).fill(NONE);
    this.flags = new Uint8Array(W * H);
    // 首都をなるべく離して置く
    const spawns = [];
    let minD = Math.sqrt(this.map.landCount / NATIONS.length) * 1.1;
    for (const n of this.meta.nations) {
      for (let tries = 0; tries < 20000; tries++) {
        if (tries % 500 === 499) minD *= 0.85;
        const i = Math.floor(Math.random() * this.map.N);
        if (!this.map.terrain[i] || this.owner[i] !== NONE) continue;
        const x = i % W, y = (i / W) | 0;
        if (spawns.some((s) => Math.hypot(s % W - x, ((s / W) | 0) - y) < minD)) continue;
        spawns.push(i);
        n.capital = i;
        this.owner[i] = n.id;
        for (const j of neighbors(i, W, H)) if (this.map.terrain[j] && this.owner[j] === NONE) this.owner[j] = n.id;
        break;
      }
    }
    for (let k = 0; k * CHUNK < W * H; k++) this.dirtyChunks.add(k);
    this.recount();
  }

  recount() {
    this.tiles = this.meta.nations.map(() => 0);
    for (const o of this.owner) if (o !== NONE) this.tiles[o]++;
    this.bAt = new Map(this.meta.buildings.map((b) => [b.i, b]));
  }

  // 変わった地図の区切りと国の情報を保存する（1回の行動ごとではなく、2秒ごとにまとめて）
  async flush(now = false) {
    if (!now) return this.ctx.storage.setAlarm(Date.now() + 2000);
    const puts = { meta: this.meta };
    for (const k of this.dirtyChunks) {
      puts['o:' + k] = this.owner.slice(k * CHUNK, (k + 1) * CHUNK);
      puts['f:' + k] = this.flags.slice(k * CHUNK, (k + 1) * CHUNK);
    }
    this.dirtyChunks.clear();
    await this.ctx.storage.put(puts);
  }
  async alarm() {
    await this.load();
    await this.flush(true);
  }

  setCell(i, o, f) {
    const old = this.owner[i];
    if (old === o && this.flags[i] === f) return;
    if (old !== o) {
      if (old !== NONE) this.tiles[old]--;
      if (o !== NONE) this.tiles[o]++;
      const b = this.bAt.get(i);
      if (b) {
        if (o === NONE) { this.meta.buildings = this.meta.buildings.filter((x) => x !== b); this.bAt.delete(i); }
        else b.nation = o;   // 建物は占領される
        this.metaChanged = true;
      }
    }
    this.owner[i] = o;
    this.flags[i] = f;
    this.dirtyChunks.add(Math.floor(i / CHUNK));
    this.pending.add(i);
  }
  shield(i) { return this.flags[i] & 1; }
  fallout(i) { return this.flags[i] >> 1; }

  // 日付が変わっていたら、変わった日数ぶん毎日の処理を進める
  rollover() {
    const m = this.meta, today = jstDate();
    let changed = false;
    while (m.lastDate < today) {
      m.lastDate = nextDate(m.lastDate);
      for (let i = 0; i < this.flags.length; i++) {
        const fo = this.flags[i] >> 1;
        if (fo > 0) this.setCell(i, this.owner[i], ((fo - 1) << 1) | (this.flags[i] & 1));
      }
      for (const b of m.buildings) if (b.cd > 0) b.cd--;
      changed = true;
    }
    if (!m.ended && this.day() > SEASON_DAYS) {
      m.ended = true;
      m.winner = this.tiles.indexOf(Math.max(...this.tiles));
      this.log(`シーズン${m.seasonNo}終了！優勝は${m.nations[m.winner].name}`, m.winner, 'good');
      changed = true;
    }
    if (changed) this.metaChanged = true;
    return changed;
  }
  day() { return diffDays(this.meta.lastDate, this.meta.seasonStart) + 1; }
  cnt(nation, type) { let c = 0; for (const b of this.meta.buildings) if (b.nation === nation && b.type === type) c++; return c; }
  town(i) { const p = this.map.prov[i]; return p >= 0 ? this.map.provinces[p].name : '海'; }
  log(text, nation, cls = '') {
    const l = { text, nation, cls, day: this.day(), t: Date.now() };
    this.meta.logs.push(l);
    if (this.meta.logs.length > LOG_KEEP) this.meta.logs.splice(0, this.meta.logs.length - LOG_KEEP);
    this.pendingLogs.push(l);
  }
  buildCost(nation, type) { return Math.round(BUILD[type].base * (1 + BUILD[type].scale * this.cnt(nation, type))); }

  // 地図以外の、みんなに見せる情報
  publicMeta() {
    const m = this.meta;
    return {
      seasonNo: m.seasonNo, seed: m.seed, W: m.W, H: m.H, date: m.lastDate, day: this.day(), seasonDays: SEASON_DAYS,
      ended: m.ended, winner: m.winner, buildings: m.buildings, logs: m.logs.slice(-50),
      nations: m.nations.map((n) => ({ ...n, tiles: this.tiles[n.id] })),
      costs: Object.fromEntries(m.nations.map((n) => [n.id, Object.fromEntries(Object.keys(BUILD).map((k) => [k, this.buildCost(n.id, k)]))])),
      nukeCosts: Object.fromEntries(Object.entries(NUKE).map(([k, v]) => [k, v.cost])),
    };
  }
  meInfo(p) {
    if (!p || p.seasonNo !== this.meta.seasonNo) return null;
    return { name: p.name, nation: p.nation, gold: p.gold, actedToday: p.lastAct === this.meta.lastDate };
  }

  // 地図をまとめて送る（持ち主＋盾・汚染、gzip で圧縮）
  mapResponse() {
    const n = this.owner.length, buf = new Uint8Array(n * 2);
    buf.set(this.owner, 0);
    buf.set(this.flags, n);
    const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream, {
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-seq': String(this.meta.seq) },
    });
  }

  // ===== IP の記録 =====
  async ipStat(hash, masked) {
    const key = `ip:${this.meta.lastDate}:${hash}`;
    const s = (await this.ctx.storage.get(key)) || { hash, masked, date: this.meta.lastDate, requests: 0, accounts: 0, actions: 0, blocked: 0, players: [], lastSeen: 0 };
    s.key = key;
    return s;
  }
  async saveIpStat(s) {
    s.lastSeen = Date.now();
    const { key, ...rest } = s;
    await this.ctx.storage.put(key, rest);
  }
  async block(s, message, status = 429) {
    s.blocked++;
    await this.saveIpStat(s);
    return fail(message, status);
  }
  // 1分あたりのリクエスト数を数える
  rateLimited(hash) {
    const now = Date.now();
    let r = this.rate.get(hash);
    if (!r || now - r.start > 60e3) { r = { start: now, count: 0 }; this.rate.set(hash, r); }
    r.count++;
    if (this.rate.size > 20000) for (const [k, v] of this.rate) if (now - v.start > 60e3) this.rate.delete(k);
    return r.count > this.limits.perMinute;
  }

  async fetch(req) {
    await this.load();
    const url = new URL(req.url), path = url.pathname;
    const ip = clientIp(req, this.env);
    const ipHash = (await sha256((this.env.IP_SALT || 'dev-salt') + '|' + ip)).slice(0, 32);
    const masked = maskIp(ip);

    if (path.startsWith('/api/admin/')) return this.admin(req, path);

    if (this.rateLimited(ipHash)) {
      if (this.rate.get(ipHash).count === this.limits.perMinute + 1) {   // 超えた最初の1回だけ記録する
        const s = await this.ipStat(ipHash, masked);
        s.blocked++;
        await this.saveIpStat(s);
      }
      return fail('アクセスが多すぎます。少し待ってからもう一度どうぞ', 429);
    }
    if (await this.ctx.storage.get('ban:' + ipHash)) return fail('この回線からは参加できません', 403);

    if (this.rollover()) { await this.flush(true); this.scheduleBroadcast(true); }

    const token = req.headers.get('X-Player-Token') || '';
    const tokenHash = token ? await sha256(token) : '';
    const player = tokenHash ? await this.ctx.storage.get('p:' + tokenHash) : null;

    if (path === '/api/ws') return this.socket(req, ipHash);
    if (req.method === 'GET' && path === '/api/map') return this.mapResponse();
    if (req.method === 'GET' && path === '/api/state') {
      return json({ meta: this.publicMeta(), seq: this.meta.seq, me: this.meInfo(player), limits: { actionsPerDay: this.limits.actionsPerDay } });
    }
    if (req.method !== 'POST') return fail('not found', 404);
    let body = {};
    try { body = await req.json(); } catch { return fail('リクエストが正しくありません'); }

    const s = await this.ipStat(ipHash, masked);
    s.requests++;

    if (path === '/api/join') {
      if (player && player.seasonNo === this.meta.seasonNo) return fail('すでに参加しています');
      // 前のシーズンのアカウントで入り直すときは、新しいアカウントとして数えない
      if (!player && s.accounts >= this.limits.accountsPerDay) return this.block(s, 'この回線からは、今日はこれ以上参加できません');
      const nation = body.nation | 0, name = cleanName(body.name);
      if (!this.meta.nations[nation]) return fail('国を選んでください');
      if (!name) return fail('名前を入れてください');
      const newToken = player ? token : randomHex(24);
      const p = { id: randomHex(6), name, nation, gold: 20, lastAct: '', created: this.meta.lastDate, ips: [ipHash], seasonNo: this.meta.seasonNo };
      await this.ctx.storage.put('p:' + (await sha256(newToken)), p);
      this.meta.nations[nation].members++;
      if (!player) s.accounts++;
      s.players = [...new Set([...s.players, `${name}（${this.meta.nations[nation].name}）`])].slice(0, 20);
      this.log(`${name}さんが${this.meta.nations[nation].name}に加わった`, nation);
      this.metaChanged = true;
      await this.saveIpStat(s);
      await this.flush();
      this.scheduleBroadcast();
      return json({ token: newToken, me: this.meInfo(p), meta: this.publicMeta(), seq: this.meta.seq });
    }

    if (!player) return fail('先に国を選んで参加してください', 401);
    if (player.seasonNo !== this.meta.seasonNo) return fail('新しいシーズンが始まりました。もう一度参加してください', 401);
    if (this.meta.ended) return fail('シーズンは終了しました');
    if (!player.ips.includes(ipHash)) player.ips = [...player.ips, ipHash].slice(-10);
    const before = new Set(this.pending);
    let result;
    if (path === '/api/act') {
      if (player.lastAct === this.meta.lastDate) return fail('今日の1マスはもう使いました');
      if (s.actions >= this.limits.actionsPerDay) return this.block(s, 'この回線からの今日の行動回数が上限に達しました');
      result = this.act(player, body.cell | 0, body.kind);
      if (result.error) return fail(result.error);
      player.lastAct = this.meta.lastDate;
      player.gold += 10 + this.cnt(player.nation, 'city') * 3;
      s.actions++;
    } else if (path === '/api/build') {
      result = this.build(player, String(body.type), body.cell | 0);
      if (result.error) return fail(result.error);
    } else if (path === '/api/nuke') {
      result = this.nuke(player, String(body.type), body.cell | 0);
      if (result.error) return fail(result.error);
    } else {
      return fail('not found', 404);
    }
    await this.ctx.storage.put('p:' + tokenHash, player);   // 「今日は行動済み」はすぐ保存する
    await this.saveIpStat(s);
    await this.flush();
    if (result.events) this.pendingEvents.push(...result.events);
    this.scheduleBroadcast();
    // この行動で変わったマスは、すぐ本人に返す（ほかの人には1秒以内に配信）
    const cells = [];
    for (const i of this.pending) if (!before.has(i)) cells.push(i, this.owner[i], this.flags[i]);
    return json({ ok: true, me: this.meInfo(player), meta: this.publicMeta(), cells, events: result.events || [] });
  }

  // ===== 行動 =====
  act(p, i, kind) {
    const m = this.map, n = p.nation, nat = this.meta.nations, who = `${nat[n].name}（${p.name}）`;
    if (i < 0 || i >= m.N || !m.terrain[i]) return { error: '陸地のマスを選んでください' };
    if (kind === 'guard') {
      if (this.owner[i] !== n) return { error: '守れるのは自分の国のマスだけです' };
      if (this.shield(i)) return { error: 'もう守っています' };
      this.setCell(i, n, this.flags[i] | 1);
      this.log(`${who}が ${this.town(i)} を守った`, n);
      return {};
    }
    if (kind !== 'take') return { error: '行動を選んでください' };
    if (this.owner[i] === n) return { error: '自分の国のマスです' };
    if (this.fallout(i) > 0) return { error: `放射能汚染中です（あと${this.fallout(i)}日）` };
    const o = this.owner[i];
    if (this.tiles[n] > 0) {
      if (!neighbors(i, m.W, m.H).some((j) => this.owner[j] === n)) return { error: '自分の国のとなりのマスしか取れません' };
    } else if (o !== NONE) return { error: '国がなくなったときは、無人のマスから建て直せます' };
    if (o !== NONE && this.shield(i)) {
      this.setCell(i, o, this.flags[i] & ~1);
      this.log(`${nat[o].name}が ${this.town(i)} を守った（${who}の攻撃）`, o);
      return {};
    }
    this.setCell(i, n, this.flags[i] & ~1);
    this.log(o !== NONE ? `${who}が ${nat[o].name}の ${this.town(i)} を取った` : `${who}が ${this.town(i)} を取った`, n);
    return {};
  }

  build(p, type, i) {
    if (!BUILD[type]) return { error: '建物を選んでください' };
    if (this.owner[i] !== p.nation) return { error: '自分の国のマスに建ててください' };
    if (this.bAt.has(i)) return { error: 'そのマスにはもう建物があります' };
    const cost = this.buildCost(p.nation, type);
    if (p.gold < cost) return { error: '金が足りません' };
    p.gold -= cost;
    const b = { type, i, nation: p.nation, cd: 0 };
    this.meta.buildings.push(b);
    this.bAt.set(i, b);
    this.metaChanged = true;
    this.log(`${this.meta.nations[p.nation].name}（${p.name}）が ${this.town(i)} に${BUILD[type].name}を建てた`, p.nation);
    return {};
  }

  nuke(p, type, i) {
    const m = this.map, NK = NUKE[type], nat = this.meta.nations;
    if (!NK) return { error: '核を選んでください' };
    if (i < 0 || i >= m.N) return { error: '目標を選んでください' };
    if (p.gold < NK.cost) return { error: '金が足りません' };
    const x = i % m.W, y = (i / m.W) | 0;
    const dist = (b) => Math.hypot(b.i % m.W - x, ((b.i / m.W) | 0) - y);
    const silos = this.meta.buildings.filter((b) => b.nation === p.nation && b.type === 'silo');
    if (!silos.length) return { error: 'ミサイル基地がありません' };
    const ready = silos.filter((b) => !b.cd).sort((a, b) => dist(a) - dist(b));
    if (!ready.length) return { error: 'ミサイル基地が再装填中です' };
    p.gold -= NK.cost;
    ready[0].cd = SILO_RELOAD;
    this.metaChanged = true;
    const victim = m.terrain[i] ? this.owner[i] : NONE;
    const who = `${nat[p.nation].name}（${p.name}）`;
    const ev = { kind: 'nuke', type, from: ready[0].i, to: i, nation: p.nation };
    this.log(`☢ ${who}が${victim !== NONE ? nat[victim].name + 'の ' : ''}${this.town(i)} に${NK.name}を発射！`, p.nation, 'warn');
    if (type !== 'mirv') {
      const sam = this.meta.buildings.find((b) => b.type === 'sam' && b.nation !== p.nation && !b.cd && dist(b) <= SAM_RANGE);
      if (sam) {
        sam.cd = SAM_RELOAD;
        ev.interceptBy = sam.i;
        this.log(`🛡 ${nat[sam.nation].name}の迎撃基地が${NK.name}を撃ち落とした`, sam.nation, 'good');
        return { events: [ev] };
      }
      this.detonate(i, NK.r, NK.fallout);
      return { events: [ev] };
    }
    // MIRV：相手の国のマスにばらばらに落ちる
    let targets = [];
    if (victim !== NONE) {
      for (let k = 0; k < 4000 && targets.length < NK.warheads * 4; k++) {   // 大きい国でも全マスは調べない
        const t = Math.floor(Math.random() * m.N);
        if (this.owner[t] === victim) targets.push(t);
      }
    }
    targets = targets.slice(0, NK.warheads);
    while (targets.length < NK.warheads) {
      const tx = Math.round(x + (Math.random() - 0.5) * 40), ty = Math.round(y + (Math.random() - 0.5) * 40);
      if (tx >= 0 && ty >= 0 && tx < m.W && ty < m.H) targets.push(ty * m.W + tx);
    }
    for (const t of targets) this.detonate(t, NK.r, NK.fallout);
    ev.warheads = targets;
    return { events: [ev] };
  }
  detonate(i, r, days) {
    const m = this.map, x0 = i % m.W, y0 = (i / m.W) | 0, R = Math.ceil(r);
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const x = x0 + dx, y = y0 + dy;
      if (x < 0 || y < 0 || x >= m.W || y >= m.H || Math.hypot(dx, dy) > r) continue;
      const k = y * m.W + x;
      if (!m.terrain[k]) continue;
      this.setCell(k, NONE, Math.max(this.fallout(k), days) << 1);
    }
  }

  // ===== リアルタイム配信（1秒ごとにまとめて送る） =====
  socket(req, ipHash) {
    if (req.headers.get('Upgrade') !== 'websocket') return fail('websocket only', 426);
    if (this.ctx.getWebSockets(ipHash).length >= this.limits.sockets) return fail('同じ回線からの接続が多すぎます', 429);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [ipHash]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  scheduleBroadcast(now = false) {
    if (now) { clearTimeout(this.broadcastTimer); this.broadcastTimer = 0; this.broadcast(); return; }
    if (!this.broadcastTimer) this.broadcastTimer = setTimeout(() => { this.broadcastTimer = 0; this.broadcast(); }, 1000);
  }
  broadcast() {
    if (!this.pending.size && !this.pendingLogs.length && !this.metaChanged && !this.pendingEvents.length) return;
    const cells = [];
    for (const i of this.pending) cells.push(i, this.owner[i], this.flags[i]);
    this.meta.seq++;
    const msg = JSON.stringify({
      type: 'diff', seq: this.meta.seq, cells, events: this.pendingEvents,
      meta: this.publicMeta(),
    });
    this.pending.clear();
    this.pendingLogs = [];
    this.pendingEvents = [];
    this.metaChanged = false;
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* 切断済み */ } }
    this.flush();
  }
  webSocketMessage() { /* クライアントからは何も受け取らない */ }
  webSocketClose(ws, code) { try { ws.close(code, 'bye'); } catch { /* 切断済み */ } }

  // ===== 管理（IP の監視・ブロック・シーズンのリセット） =====
  async admin(req, path) {
    const key = this.env.ADMIN_KEY;
    if (!key || !safeEqual(req.headers.get('X-Admin-Key') || '', key)) return fail('管理キーが違います', 401);
    if (req.method === 'GET' && path === '/api/admin/ips') {
      const rows = [];
      let d = this.meta.lastDate;
      for (let k = 0; k < 3; k++, d = prevDate(d)) {
        const list = await this.ctx.storage.list({ prefix: `ip:${d}:` });
        for (const v of list.values()) rows.push(v);
      }
      // 怪しい順に上位だけ返す（1万人規模だと全部は多すぎるため）
      const score = (r) => r.accounts * 3 + r.blocked * 5 + (r.actions > this.limits.actionsPerDay ? 2 : 0);
      rows.sort((a, b) => score(b) - score(a) || b.lastSeen - a.lastSeen);
      const bans = [...(await this.ctx.storage.list({ prefix: 'ban:' })).entries()].map(([k, v]) => ({ hash: k.slice(4), ...v }));
      const sockets = this.ctx.getWebSockets().length;
      return json({ today: this.meta.lastDate, limits: this.limits, total: rows.length, rows: rows.slice(0, 300), bans, sockets });
    }
    let body = {};
    try { body = await req.json(); } catch { /* 空でよい */ }
    if (req.method === 'POST' && path === '/api/admin/ban') {
      const hash = String(body.hash || '').replace(/[^0-9a-f]/g, '').slice(0, 32);
      if (hash.length !== 32) return fail('hash が正しくありません');
      if (body.ban) await this.ctx.storage.put('ban:' + hash, { masked: String(body.masked || '').slice(0, 64), at: Date.now() });
      else await this.ctx.storage.delete('ban:' + hash);
      for (const ws of this.ctx.getWebSockets(hash)) { try { ws.close(4003, 'banned'); } catch { /* 切断済み */ } }
      return json({ ok: true });
    }
    if (req.method === 'POST' && path === '/api/admin/reset') {
      this.startSeason(this.meta.seasonNo + 1);
      this.log(`シーズン${this.meta.seasonNo}が始まった！`, -1, 'good');
      await this.flush(true);
      const msg = JSON.stringify({ type: 'reload' });
      for (const ws of this.ctx.getWebSockets()) { try { ws.send(msg); } catch { /* 切断済み */ } }
      return json({ ok: true });
    }
    return fail('not found', 404);
  }
}
