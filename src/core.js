/* 47都道府県対抗 陣取り合戦（RTS版）— 単一HTML
 * 構成: core.js（CONFIG・ユーティリティ・マップ・カメラ・WebGL描画）/ rts_sim.js（ルール・AI）/ app.js（画面・入力・ステートマシン）
 * tools/build.py がこれらを1つの <script> にまとめる。
 */

// =====================================================================
// CONFIG（調整値）
// =====================================================================
const CONFIG = {
  // =================================================================
  // 7日間（24時間ずっと進む）のシーズン向けのバランス
  //   目安：兵士は県をまたぐのに数分・兵舎は15分に1人・建物は30〜60分に1つ・
  //         町の占領は10人で約15分・県庁は約40分
  // =================================================================
  SEASON_DAYS: 7,                // 7日たったら、その時点で支配人口1位の県が優勝
  WIN_RATIO: 0.5,                // それより前に全国の人口の50%を支配すれば即優勝
  // ---- 参加者（全国で約1000人。今はプレイヤー以外をAIが担当）
  PARTICIPANTS_PER_MILLION: 8,
  MIN_PARTICIPANTS: 3,
  // ---- 進行
  TICK: 0.25,                    // シミュレーションの刻み（秒）
  MAX_TICK: 4,                   // 早送り・サーバーでの最大の刻み
  PATH_BUDGET: 20,               // 1刻みあたりの経路探索の上限
  THINK_INTERVAL: 3,             // 兵士が次の行動を考える間隔（秒）
  // ---- 資源（1人あたり。/秒。かっこ内は1時間あたり）
  START_RES: { food: 300, wood: 400, gold: 200 },
  BASE_INCOME: { food: 0.033, wood: 0.04, gold: 0.02 },   // (120 / 144 / 72)
  CAPITAL_MAKE: { food: 0.033, wood: 0.033, gold: 0.033 }, // 県庁の収入（県のAIへ）
  LUMBER_PER_FOREST: 0.002,      // 製材所：周りの森1か所あたりの木材
  LUMBER_MAX: 0.067,             // (240)
  LUMBER_MIN_FOREST: 8,
  // ---- 兵士
  UNIT_HP: 100,
  UNIT_SPEED: 0.6,               // マス/秒（1マス≒0.5km。県をまたぐのに数分）
  UNIT_DPS: 1.6,                 // 1対1で約1分で決着
  ATTACK_RANGE: 2.5,
  AGGRO_RANGE: 12,
  HOME_BONUS: 1.25,
  ATTRITION: 0.05,               // 敵の領土にいると減るHP/秒
  REGEN: 0.25,                   // 自県の領土で休むと回復するHP/秒
  BUILDING_DPS_MULT: 0.6,
  START_UNITS_RATIO: 0.5,
  UNIT_CAP_PER_PARTICIPANT: 2.5,
  UNIT_CAP_PER_NODE: 0.3,        // 拠点が多い県が雪だるま式に強くならないよう小さめ
  CAPITAL_RANGE: 13, CAPITAL_DPS: 2.4,
  // ---- 拠点（県庁・町・砦）
  CAPTURE_RADIUS: 7,
  CAPTURE_NEED: { capital: 45000, town: 18000, fort: 24000 },  // （攻撃側−守備側）の人数×1秒で1ポイント（町：差15人で約20分）
  CAPTURE_MAX_RATE: 20,
  CAPTURE_DECAY: 0.5,
  RECENT_HATCH: 1800,
  // ---- 旗（領土の取り方）：兵士が敵の領土に旗を立て、旗の周りの正方形に自分の兵がいる状態を続けると、その正方形が自分の領土に
  FLAG_MODE: true,
  FLAG_HOLD: 6 * 3600,           // 6時間守り続けると獲得
  FLAG_SIZE: 20,                 // 正方形の一辺（マス。細かい地図では3倍）
  FLAG_DECAY: 100 / 600,         // 正方形の中に自分の兵がいないと、体力が毎秒この%ずつ減る（10分で消える）
  FLAG_PER_PART: 0.12,
  EVENT_EVERY: 6 * 3600,         // 出来事（大雨・士気高揚・疫病・援軍）が起きる間隔（秒）
  EVENT_LEN: 3 * 3600,           // 大雨・士気高揚が続く時間
  PLAYER_GENERAL: 600,           // あなたの大将：やられたらこの秒数で県庁に復活（0で大将なし）
  FINAL_PHASE: 0.75,             // シーズンの最後の1/4は「決戦」：旗が FINAL_RATE 倍の速さで取れる（終盤に逆転が起きやすく）
  FINAL_RATE: 2,
  WAR_TIME: 12 * 3600,
  // ---- 作戦（あなたが使える技。秒は使ったあと次に使えるまで）
  ABILITIES: {
    barrage: { name: '砲撃', icon: '💣', cd: 720, desc: 'タップした場所に砲弾8発' },
    reinforce: { name: '援軍', icon: '🛡', cd: 1200, desc: '県庁に足軽10人' },
    rally: { name: '鼓舞', icon: '📯', cd: 960, desc: '画面の中のあなたの兵の攻撃・足が60秒アップ' },
  },           // 宣戦布告：各県はこの時間ごとに、主に攻める相手の県を1つ選ぶ（弱い隣の県が狙われやすい）           // 県が同時に立てられる旗の数：参加者1人あたり（＋2）            // 占領されてから30分は斜線
  NODE_RADIUS: 36,
  NODE_MIN_DIST: 24,
  // ---- 建物
  BUILD_GAP: 2.2,
  MAX_BUILDINGS_PER_PARTICIPANT: 5,
  // ---- AI
  AI_BUILD_INTERVAL: 90,         // 県のAI参加者10人で、この秒数に1回建てる
  AI_PLAN_INTERVAL: 30,
  AI_TARGET_TIMEOUT: 3600,
  AI_DEFENDER_RATIO: 0.25,
  // ---- 画面
  CAMERA_PITCH: 42, TOP_PITCH: 90, TITLE_PITCH: 75, FOV: 34,
  ZOOM_MIN: 6, ZOOM_MAX: 13500,
  FILL: 0.035, FILL_TOP: 0.7,     // 領土の塗りの濃さ（斜め／真上）。斜めは国境線が主役
  TREE_MAX: 3500,
  LOG_MAX: 3, BANNER_MS: 1800, MINIMAP_REFRESH: 1.0, MAX_DPR: 2, HUD_REFRESH: 0.25,
};
const RES_KEYS = ['food', 'wood', 'gold'];
const RES_ICON = { food: '🌾', wood: '🪵', gold: '💰' };
// 判子（朱印）の漢字：絵文字の代わりに、建物・資源・ボタンを漢字一文字の印で表す
const SEAL = {
  farm: '農', lumber: '材', market: '市', mine: '鉱', fishery: '漁', ranch: '牧', brewery: '酒', storehouse: '蔵', mint: '両',
  barracks: '兵', stable: '馬', ninja: '忍', foundry: '砲', gaslab: '毒', port: '港', airfield: '空', bomberbase: '爆',
  tower: '櫓', bunker: '堡', battery: '台', rocket: '箭', aagun: '高', coastgun: '沿', wall: '垣', mines: '雷', gasshelter: '壕', radar: '探', trench: '塹',
  hospital: '医', shrine: '社', beacon: '烽', depot: '站', temple: '寺', lighthouse: '灯', town: '町', fort: '砦', castle: '城',
  food: '糧', wood: '木', gold: '金',
};
const seal = (k, cls = '') => icon(k, cls);   // 絵のアイコン（icons.js）
const RES_NAME = { food: '食料', wood: '木材', gold: '金' };
/** 建物の種類 */
/**
 * 建物（36種類）。働きは項目で決まる（ルールは rts_sim.js）：
 *   make: 資源/秒 ・ forest: 森から木材 ・ unit/train/trainFood: 兵の訓練（種類・秒・食料）
 *   range/dps/hits/splash/rate: 敵を撃つ（hits: land=陸 sea=海 air=空、rate=何秒に1回まとめて撃つか）
 *   aura: 周りの味方（または敵）への効果 ・ need: 建てる場所の条件（mountain=山の近く coast=海の近く plain=平地）
 *   node: 拠点（国境を広げる）
 */
const BUILDINGS = {
  // ---- 経済
  farm: { cat: 'eco', name: '農場', icon: '🌾', cost: { wood: 60 }, hp: 150, desc: '食料 +144/時（森を切り開くと半分・山には建てられない）', make: { food: 0.04 } },
  lumber: { cat: 'eco', name: '製材所', icon: '🪓', cost: { wood: 40, gold: 20 }, hp: 150, desc: '周りの森から木材（最大 +240/時）', forest: true },
  market: { cat: 'eco', name: '市場', icon: '🏪', cost: { wood: 120 }, hp: 200, desc: '金 +120/時', make: { gold: 0.033 } },
  mine: { cat: 'eco', name: '金山', icon: '⛏️', cost: { wood: 100 }, hp: 250, desc: '金 +180/時（山の近くだけ）', make: { gold: 0.05 }, need: 'mountain' },
  fishery: { cat: 'eco', name: '漁港', icon: '🐟', cost: { wood: 80 }, hp: 180, desc: '食料 +216/時（海の近くだけ）', make: { food: 0.06 }, need: 'coast' },
  ranch: { cat: 'eco', name: '牧場', icon: '🐄', cost: { wood: 90 }, hp: 180, desc: '食料 +180/時（平地だけ）', make: { food: 0.05 }, need: 'plain' },
  brewery: { cat: 'eco', name: '酒蔵', icon: '🍶', cost: { wood: 100, gold: 40 }, hp: 200, desc: '金 +144/時・木材 +36/時', make: { gold: 0.04, wood: 0.01 } },
  storehouse: { cat: 'eco', name: '蔵', icon: '📦', cost: { wood: 120 }, hp: 300, desc: '周り10マスの味方の経済の建物の生産 +30%', aura: { r: 10, eco: 1.3 } },
  mint: { cat: 'eco', name: '両替商', icon: '💴', cost: { wood: 150, gold: 100 }, hp: 220, desc: '金 +216/時', make: { gold: 0.06 } },
  // ---- 兵の生産
  barracks: { cat: 'mil', name: '兵舎', icon: '⚔️', cost: { wood: 150, gold: 50 }, hp: 350, desc: '足軽を訓練（10分ごと・食料30）', unit: 'ashigaru', train: 600, trainFood: 30 },
  stable: { cat: 'mil', name: '厩舎', icon: '🐎', cost: { wood: 160, gold: 80 }, hp: 350, desc: '騎馬隊を訓練：足が速く強い（8分ごと・食料40）', unit: 'cavalry', train: 480, trainFood: 40 },
  ninja: { cat: 'mil', name: '忍びの里', icon: '🥷', cost: { wood: 120, gold: 150 }, hp: 250, desc: '忍者を訓練：塔に見つからず、建物を壊すのが得意（10分ごと）', unit: 'ninja', train: 600, trainFood: 30 },
  foundry: { cat: 'mil', name: '砲兵工廠', icon: '💣', cost: { wood: 200, gold: 200 }, hp: 450, desc: '大砲隊を訓練：遠くから建物と兵をまとめて砲撃（12分ごと）', unit: 'cannon', train: 720, trainFood: 40 },
  gaslab: { cat: 'mil', name: '毒ガス研究所', icon: '☣️', cost: { wood: 150, gold: 250 }, hp: 300, desc: '毒ガス兵を訓練：敵の集まりに毒ガスを撒く（12分ごと）', unit: 'gas', train: 720, trainFood: 30 },
  port: { cat: 'mil', name: '軍港', icon: '⚓', cost: { wood: 300, gold: 200 }, hp: 600, desc: '軍艦を造る：海を進み、海岸の敵を砲撃（15分ごと・海の近くだけ）', unit: 'ship', train: 900, trainFood: 60, need: 'coast' },
  airfield: { cat: 'mil', name: '飛行場', icon: '✈️', cost: { wood: 300, gold: 300 }, hp: 500, desc: '戦闘機を造る：敵の飛行機を落とし、地上も撃つ（10分ごと）', unit: 'fighter', train: 600, trainFood: 40 },
  bomberbase: { cat: 'mil', name: '爆撃機基地', icon: '🛩️', cost: { wood: 350, gold: 400 }, hp: 550, desc: '爆撃機を造る：敵の拠点の上から爆弾を落とす（15分ごと）', unit: 'bomber', train: 900, trainFood: 60 },
  // ---- 防衛
  tower: { cat: 'def', name: '見張り塔', icon: '🗼', cost: { wood: 80, gold: 60 }, hp: 450, desc: '近くの敵兵を撃つ', range: 11, dps: 1.9, hits: 'land' },
  bunker: { cat: 'def', name: 'トーチカ', icon: '🧱', cost: { wood: 150, gold: 100 }, hp: 900, desc: '射程は短いが強力で頑丈', range: 7, dps: 4.5, hits: 'land' },
  battery: { cat: 'def', name: '砲台', icon: '🎯', cost: { wood: 200, gold: 150 }, hp: 600, desc: '遠くの敵兵・軍艦をまとめて砲撃（範囲攻撃）', range: 16, dps: 3, hits: 'land,sea', splash: 2.5, rate: 3 },
  rocket: { cat: 'def', name: 'ロケット陣地', icon: '🚀', cost: { wood: 250, gold: 300 }, hp: 400, desc: 'とても遠くへ大きな範囲攻撃（発射は遅い）', range: 28, dps: 3.5, hits: 'land', splash: 4, rate: 8 },
  aagun: { cat: 'def', name: '高射砲', icon: '🎇', cost: { wood: 150, gold: 150 }, hp: 400, desc: '飛行機だけを撃つ（遠くまで届く）', range: 18, dps: 6, hits: 'air' },
  coastgun: { cat: 'def', name: '沿岸砲', icon: '🌊', cost: { wood: 200, gold: 200 }, hp: 700, desc: '軍艦を遠くから撃つ（海の近くだけ）', range: 22, dps: 5, hits: 'sea,land', need: 'coast' },
  wall: { cat: 'def', name: '石垣', icon: '🪨', cost: { wood: 100 }, hp: 2000, desc: 'とても頑丈。周り6マスの敵兵の足が半分に', aura: { r: 6, enemySlow: 0.5 } },
  mines: { cat: 'def', name: '地雷原', icon: '💥', cost: { wood: 60, gold: 40 }, hp: 100, desc: '近くを通った敵兵に大きな被害（30秒で再装填）', mine: { r: 3, dmg: 60, every: 30 } },
  gasshelter: { cat: 'def', name: '防毒壕', icon: '😷', cost: { wood: 100, gold: 60 }, hp: 300, desc: '周り12マスの味方は毒ガスの被害が1/5', aura: { r: 12, gasRes: 0.2 } },
  radar: { cat: 'def', name: 'レーダー', icon: '📡', cost: { wood: 150, gold: 200 }, hp: 300, desc: '周り25マスで忍者を見つける・高射砲の威力 +50%', aura: { r: 25, detect: true, aa: 1.5 } },
  trench: { cat: 'def', name: '塹壕', icon: '🪖', cost: { wood: 70 }, hp: 400, desc: '周り6マスの味方の受ける被害 −40%', aura: { r: 6, armor: 0.6 } },
  // ---- 支援
  hospital: { cat: 'sup', name: '診療所', icon: '⛑️', cost: { wood: 120, gold: 60 }, hp: 250, desc: '周り10マスの味方を回復（+3/秒）', aura: { r: 10, heal: 3 } },
  shrine: { cat: 'sup', name: '神社', icon: '⛩️', cost: { wood: 100, gold: 100 }, hp: 300, desc: '周り12マスの味方の攻撃 +30%', aura: { r: 12, dps: 1.3 } },
  beacon: { cat: 'sup', name: '狼煙台', icon: '🔥', cost: { wood: 80 }, hp: 200, desc: '周り12マスの味方の足 +40%', aura: { r: 12, spd: 1.4 } },
  depot: { cat: 'sup', name: '兵站基地', icon: '🏕️', cost: { wood: 200, gold: 100 }, hp: 400, desc: '県の兵士の上限 +8', capPlus: 8 },
  temple: { cat: 'sup', name: '寺', icon: '🛕', cost: { wood: 150, gold: 80 }, hp: 350, desc: '周り20マスの味方の拠点は占領されにくい（1.5倍）', aura: { r: 20, hold: 1.5 } },
  lighthouse: { cat: 'sup', name: '灯台', icon: '🗼', cost: { wood: 100, gold: 50 }, hp: 250, desc: '周り25マスの味方の軍艦の攻撃 +40%（海の近くだけ）', aura: { r: 25, navy: 1.4 }, need: 'coast' },
  // ---- 拠点
  town: { cat: 'node', name: '町', icon: '🏘️', cost: { wood: 250, gold: 150 }, desc: '国境を広げる・金 +43/時', node: true, make: { gold: 0.012 } },
  fort: { cat: 'node', name: '砦', icon: '🏰', cost: { wood: 150, gold: 300 }, desc: '国境を広げ、近くの敵兵を撃つ', node: true, range: 13, dps: 2.9, hits: 'land' },
  castle: { cat: 'node', name: '城', icon: '🏯', cost: { wood: 400, gold: 600 }, desc: '広い国境（1.4倍）と強い守り。飛行機も撃つ', node: true, range: 15, dps: 3.5, hits: 'land,sea,air', radius: 1.4 },
};
const BUILD_ORDER = Object.keys(BUILDINGS);
const BUILD_CATS = [['eco', '経済'], ['mil', '兵の生産'], ['def', '防衛'], ['sup', '支援'], ['node', '拠点']];
/**
 * 兵種。dom: land=陸 sea=海 air=空。hits: 撃てる相手。vsB: 建物への攻撃の倍率。splash: 範囲攻撃の半径。
 * fuel: 飛行機が飛べる秒数（切れると基地へ帰る＝いなくなる）。stealth: 塔などに狙われない（レーダーの近くは別）
 */
const UNITS = {
  ashigaru: { name: '足軽', hp: 100, spd: 1, dps: 1.6, range: 2.5, dom: 'land', hits: 'land', vsB: 1 },
  cavalry: { name: '騎馬隊', hp: 140, spd: 2.2, dps: 2.0, range: 2.0, dom: 'land', hits: 'land', vsB: 0.8 },
  ninja: { name: '忍者', hp: 70, spd: 2.0, dps: 1.2, range: 2.0, dom: 'land', hits: 'land', vsB: 5, stealth: true },
  gas: { name: '毒ガス兵', hp: 80, spd: 0.9, dps: 0.4, range: 7, dom: 'land', hits: 'land', vsB: 0.5, gas: { r: 4, dps: 2.5, life: 20, every: 8 } },
  cannon: { name: '大砲隊', hp: 120, spd: 0.5, dps: 3.5, range: 9, dom: 'land', hits: 'land,sea', vsB: 3, splash: 2.5 },
  ship: { name: '軍艦', hp: 400, spd: 1.5, dps: 4, range: 11, dom: 'sea', hits: 'land,sea,air', vsB: 2, splash: 2 },
  fighter: { name: '戦闘機', hp: 150, spd: 6, dps: 3, range: 5, dom: 'air', hits: 'air,land', vsB: 0.3, fuel: 400 },
  general: { name: '大将', hp: 450, spd: 1.4, dps: 4, range: 3, dom: 'land', hits: 'land', vsB: 1.5 },
  bomber: { name: '爆撃機', hp: 220, spd: 4.5, dps: 0, range: 0, dom: 'air', hits: '', vsB: 0, fuel: 300, bomb: { r: 3.5, dmg: 45, every: 5 } },
};
const WASTE = 48;             // 焦土（持ち主なし）を表す持ち主ID
const WASTE_COLOR = '#4a4038';

// =====================================================================
// ユーティリティ
// =====================================================================
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmt = (n) => n.toLocaleString('ja-JP');
const hexToRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const nextFrame = () => new Promise((r) => setTimeout(r, 0));
function escapeHtml(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

// =====================================================================
// マップデータ（RLE + base64 を展開）
// =====================================================================
function b64ToBytes(s) {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const TERRAIN_NAMES = ['海', '平地', '森', '山', '市街地'];
// 自然な色（草原・森・岩・街は草原寄り、雪）
const TERRAIN_COLORS = {
  1: [152, 178, 74], 2: [96, 134, 58], 3: [150, 136, 104], 4: [156, 172, 86],
  9: [226, 231, 233], 10: [176, 196, 190], 11: [240, 242, 245], 12: [216, 222, 222],
};

/** RLE（値＋可変長の長さ）を、(開始位置, 長さ, 値) の並びとして読む */
function rleRuns(b64, fn) {
  const src = b64ToBytes(b64);
  let p = 0, o = 0;
  while (p < src.length) {
    const v = src[p++];
    let len = 0, shift = 0, b;
    do { b = src[p++]; len |= (b & 127) << shift; shift += 7; } while (b & 128);
    fn(o, len, v);
    o += len;
  }
  return o;
}
const TILE = 64, TSH = 6, TMASK = 63;               // 区画は 64×64 マス
const OFF8 = [-65, -64, -63, -1, 1, 63, 64, 65];    // 区画の内側での 8方向の隣（番号の差）

/**
 * 地図データ。日本を囲む長方形（W×H）の9割は海なので、陸地を含む 64×64 マスの区画だけを持つ。
 *   マスの番号 i ＝ 区画の番号×4096 ＋ 区画内の行×64 ＋ 区画内の列（海だけの区画のマスは -1）
 *   id(x, y) で座標→番号、X(i)・Y(i) で番号→座標
 */
class MapData {
  constructor(raw) {
    this.raw = raw;
    this.W = raw.W; this.H = raw.H;
    this.TW = Math.ceil(raw.W / TILE); this.TH = Math.ceil(raw.H / TILE);
    this.prefs = [null];
    for (const p of raw.prefs) this.prefs[p.id] = p;
    this.landCells = raw.landCells;
  }
  /** 長方形の中の通し番号（y*W+x）の範囲 [o, o+len) を、行ごと・区画ごとの区切りに分けて fn(区画番号, 区画内の行, 列0, 列1) */
  forSpan(o, len, fn) {
    const W = this.W;
    let y = (o / W) | 0, x = o - y * W, left = len;
    while (left > 0) {
      const n = Math.min(left, W - x);
      let x0 = x;
      const x1 = x + n;
      while (x0 < x1) {
        const tx = x0 >> TSH, end = Math.min(x1, (tx + 1) << TSH);
        fn(tx + (y >> TSH) * this.TW, y & TMASK, x0 & TMASK, ((end - 1) & TMASK) + 1);
        x0 = end;
      }
      left -= n; x = 0; y++;
    }
  }
  async decode(progress) {
    const raw = this.raw, W = this.W;
    progress(0.1, '県のマスを展開中…'); await nextFrame();
    // 1回目：陸地を含む区画を数える
    const has = new Uint8Array(this.TW * this.TH);
    rleRuns(raw.pref, (o, len, v) => { if (v) this.forSpan(o, len, (t) => { has[t] = 1; }); });
    this.tileBase = new Int32Array(this.TW * this.TH).fill(-1);
    const tx = [], ty = [];
    for (let t = 0; t < has.length; t++) if (has[t]) { this.tileBase[t] = tx.length << (TSH * 2); tx.push(t % this.TW); ty.push((t / this.TW) | 0); }
    this.nTiles = tx.length;
    this.tileX = Int16Array.from(tx); this.tileY = Int16Array.from(ty);
    const N = this.N = this.nTiles << (TSH * 2);
    // 2回目：区画の中に値を書く
    const fill = (b64, out) => rleRuns(b64, (o, len, v) => {
      if (!v) return;
      this.forSpan(o, len, (t, ly, x0, x1) => { const b = this.tileBase[t]; if (b >= 0) out.fill(v, b + (ly << TSH) + x0, b + (ly << TSH) + x1); });
    });
    this.initPref = new Uint8Array(N);
    fill(raw.pref, this.initPref);
    progress(0.25, '地形を展開中…'); await nextFrame();
    this.terrain = new Uint8Array(N);
    fill(raw.terrain, this.terrain);
    progress(0.35, '標高を展開中…');
    // 標高（PNG・1/4 の解像度）：ブラウザの画像デコーダで読み、明るさを取り出す
    const ev = raw.elev;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('標高データを読めません')); img.src = 'data:image/png;base64,' + ev.png; });
    const cv = document.createElement('canvas');
    cv.width = ev.w; cv.height = ev.h;
    const cx = cv.getContext('2d');
    cx.drawImage(img, 0, 0);
    const px = cx.getImageData(0, 0, ev.w, ev.h).data;
    this.elev = new Uint8Array(ev.w * ev.h);
    for (let k = 0; k < this.elev.length; k++) this.elev[k] = px[k * 4];
    this.elevW = ev.w; this.elevH = ev.h; this.elevScale = ev.scale || 2;
    // データ中のマスの番号（長方形の通し番号）を、区画方式の番号に置き換える
    const conv = (d) => this.id(d % W, (d / W) | 0);
    if (!raw.converted) {
      for (const p of raw.prefs) p.capital = conv(p.capital);
      for (const l of raw.links) { l.a = conv(l.a); l.b = conv(l.b); }
      raw.autoLinks = raw.autoLinks.map(([a, b]) => [conv(a), conv(b)]);
      for (const t of raw.towns) t.cell = conv(t.cell);
      raw.converted = true;
    }
    this.finish();
  }
  /** 連絡マス・県庁・県ごとのマス数（decode と upscale の共通の仕上げ） */
  finish() {
    const raw = this.raw, N = this.N;
    // 連絡マス（隣接扱い）
    this.linkMap = new Map();
    const addLink = (a, b) => {
      if (a < 0 || b < 0) return;
      if (!this.linkMap.has(a)) this.linkMap.set(a, []);
      if (!this.linkMap.has(b)) this.linkMap.set(b, []);
      this.linkMap.get(a).push(b); this.linkMap.get(b).push(a);
    };
    this.linkName = new Map();
    for (const l of raw.links) {
      addLink(l.a, l.b);
      this.linkName.set(l.a, l.name); this.linkName.set(l.b, l.name);
    }
    for (const [a, b] of raw.autoLinks) addLink(a, b);
    this.capitalCell = this.prefs.map((p) => (p ? p.capital : -1));
    this.capitalOf = new Map();
    for (const p of this.prefs) if (p) this.capitalOf.set(p.capital, p.id);
    this.initCounts = new Int32Array(48);
    const ip = this.initPref;
    for (let i = 0; i < N; i++) if (ip[i]) this.initCounts[ip[i]]++;
  }
  /**
   * 細かい地図：元の地図の1マスを S×S マスに分けた地図（サーバー用。県・地形・海岸は元のマスと同じ）。
   * 拠点・連絡マスは元のマスの中央のマスへ移す。標高はそのまま共有する。
   */
  static upscale(c, S, keep) {   // keep：残す県の Set（地域を絞るお試し版）。なければ全国
    const m = Object.create(MapData.prototype);
    const W = c.W * S, H = c.H * S, TW = Math.ceil(W / TILE), TH = Math.ceil(H / TILE);
    m.W = W; m.H = H; m.TW = TW; m.TH = TH; m.scale = S; m.coarse = c;
    const has = new Uint8Array(TW * TH), cip = c.initPref;
    const kept = (p) => p && (!keep || keep.has(p));
    for (let i = 0; i < c.N; i++) {
      if (!kept(cip[i])) continue;
      const x = c.X(i) * S, y = c.Y(i) * S;
      for (let ty = y >> TSH; ty <= (y + S - 1) >> TSH; ty++) for (let tx = x >> TSH; tx <= (x + S - 1) >> TSH; tx++) has[ty * TW + tx] = 1;
    }
    m.tileBase = new Int32Array(TW * TH).fill(-1);
    const txs = [], tys = [];
    for (let t = 0; t < has.length; t++) if (has[t]) { m.tileBase[t] = txs.length << (TSH * 2); txs.push(t % TW); tys.push((t / TW) | 0); }
    m.nTiles = txs.length;
    m.tileX = Int16Array.from(txs); m.tileY = Int16Array.from(tys);
    const N = m.N = m.nTiles << (TSH * 2);
    m.initPref = new Uint8Array(N); m.terrain = new Uint8Array(N);
    const ct = c.terrain, cx = new Int32Array(TILE);
    for (let t = 0; t < m.nTiles; t++) {
      const x0 = txs[t] << TSH, y0 = tys[t] << TSH, b = t << (TSH * 2);
      for (let lx = 0; lx < TILE; lx++) cx[lx] = ((x0 + lx) / S) | 0;
      for (let ly = 0; ly < TILE; ly++) {
        const cy = ((y0 + ly) / S) | 0, o = b + (ly << TSH);
        for (let lx = 0; lx < TILE; lx++) {
          const j = c.id(cx[lx], cy);
          if (j >= 0 && kept(cip[j])) { m.initPref[o + lx] = cip[j]; m.terrain[o + lx] = ct[j]; }
        }
      }
    }
    m.elev = c.elev; m.elevW = c.elevW; m.elevH = c.elevH; m.elevScale = c.elevScale * S;
    const conv = (i) => (i < 0 || !kept(cip[i]) ? -1 : m.id(c.X(i) * S + (S >> 1), c.Y(i) * S + (S >> 1)));
    const r0 = c.raw;
    m.prefs = c.prefs.map((p) => (p ? { ...p, capital: conv(p.capital), cells: p.cells * S * S } : null));
    m.raw = { ...r0, W, H, dlon: r0.dlon / S, dlat: r0.dlat / S, scale: S, converted: true,
      prefs: m.prefs.filter(Boolean),
      links: r0.links.map((l) => ({ ...l, a: conv(l.a), b: conv(l.b) })).filter((l) => l.a >= 0 && l.b >= 0),
      autoLinks: r0.autoLinks.map(([a, b]) => [conv(a), conv(b)]).filter(([a, b]) => a >= 0 && b >= 0),
      towns: r0.towns.map((t) => ({ ...t, cell: conv(t.cell) })).filter((t) => t.cell >= 0),
      insets: r0.insets.map((r) => ({ ...r, poly: r.poly.map((v) => v * S) })),
      shiftRects: r0.shiftRects.map((q) => ({ ...q, x0: q.x0 * S, y0: q.y0 * S, x1: q.x1 * S + S - 1, y1: q.y1 * S + S - 1 })) };
    m.finish();
    m.landCells = m.initCounts.reduce((a, b) => a + b, 0);
    if (keep) {   // 残した県を囲む範囲（カメラ・ミニマップ用）
      let x0 = 1e9, y0 = 1e9, x1 = 0, y1 = 0;
      for (let t = 0; t < m.nTiles; t++) { x0 = Math.min(x0, txs[t] * TILE); y0 = Math.min(y0, tys[t] * TILE); x1 = Math.max(x1, (txs[t] + 1) * TILE); y1 = Math.max(y1, (tys[t] + 1) * TILE); }
      m.view = { x0, y0, w: x1 - x0, h: y1 - y0 };
    }
    m.terrScale = S;   // 地形は S×S マスのかたまり（描画では元のマスの単位でなめらかにする）
    return m;
  }
  /** 座標 → マスの番号（海だけの区画・地図の外は -1） */
  id(x, y) {
    if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
    const b = this.tileBase[(y >> TSH) * this.TW + (x >> TSH)];
    return b < 0 ? -1 : b + ((y & TMASK) << TSH) + (x & TMASK);
  }
  X(i) { return (this.tileX[i >> 12] << TSH) + (i & TMASK); }
  Y(i) { return (this.tileY[i >> 12] << TSH) + ((i >> TSH) & TMASK); }
  xy(i) { return [this.X(i), this.Y(i)]; }
  /** 8方向の隣（区画の内側は番号の差で速く、ふちは座標から） */
  nb8(i, fn) {
    const lx = i & TMASK, ly = (i >> TSH) & TMASK;
    if (lx > 0 && lx < TMASK && ly > 0 && ly < TMASK) { for (let k = 0; k < 8; k++) fn(i + OFF8[k]); return; }
    const x = this.X(i), y = this.Y(i);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const j = this.id(x + dx, y + dy);
      if (j >= 0) fn(j);
    }
  }
  isLand(i) { return i >= 0 && this.initPref[i] !== 0; }
  ownerName(o) { return o === WASTE ? '焦土（持ち主なし）' : this.prefs[o].name; }
  ownerColor(o) { return o === WASTE ? WASTE_COLOR : this.prefs[o].color; }
  paletteColors() { const c = this.prefs.map((p) => (p ? p.color : null)); c[WASTE] = WASTE_COLOR; return c; }
  /** グリッド座標 → 本来の経度緯度（インセットはずらす前の位置に戻す） */
  lonLat(x, y) {
    let lon = this.raw.lon0 + (x + 0.5) * this.raw.dlon;
    let lat = this.raw.latTop - (y + 0.5) * this.raw.dlat;
    for (const s of this.raw.shiftRects) {
      if (x >= s.x0 && x <= s.x1 && y >= s.y0 && y <= s.y1) { lon -= s.dlon; lat -= s.dlat; break; }
    }
    return [lon, lat];
  }
}

// =====================================================================
// カメラ（斜め見下ろし／真上、北が上）
// =====================================================================
class Camera {
  constructor() {
    this.tx = 1200; this.tz = 1080; this.dist = 3000; this.pitch = CONFIG.CAMERA_PITCH;
    this.yaw = 0; this.ty = 0;    // 三人称視点用（yaw=水平回転[rad], ty=注視点の高さ）
    this.goal = null;             // flyTo アニメーション
    this.pitchGoal = this.pitch;
    this.fovY = CONFIG.FOV * Math.PI / 180;
    this.w = 1; this.h = 1;
    this.vp = new Float32Array(16);
    this.bounds = [0, 0, 2400, 2160];
  }
  setViewport(w, h) { this.w = w; this.h = h; }
  /** (x,z) が画面の縦位置 anchorY(0..1) に来るように移動する */
  flyTo(x, z, dist, anchorY) {
    const d = dist == null ? this.dist : clamp(dist, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    let ox = 0, oz = 0;
    if (anchorY != null && anchorY !== 0.5) {
      const save = [this.tx, this.tz, this.dist, this.pitch];
      this.tx = 0; this.tz = 0; this.dist = d; this.pitch = this.pitchGoal;
      const a = this.groundAt(this.w / 2, this.h * anchorY);
      if (a) { ox = a.x; oz = a.z; }
      [this.tx, this.tz, this.dist, this.pitch] = save;
    }
    this.goal = { x: x - ox, z: z - oz, dist: d, t: 0, sx: this.tx, sz: this.tz, sd: this.dist };
  }
  update(dt) {
    if (this.goal) {
      const g = this.goal;
      g.t = Math.min(1, g.t + dt / 0.7);
      const e = g.t < 0.5 ? 4 * g.t * g.t * g.t : 1 - Math.pow(-2 * g.t + 2, 3) / 2;
      this.tx = g.sx + (g.x - g.sx) * e;
      this.tz = g.sz + (g.z - g.sz) * e;
      this.dist = Math.exp(Math.log(g.sd) + (Math.log(g.dist) - Math.log(g.sd)) * e);
      if (g.t >= 1) this.goal = null;
    }
    this.pitch += (this.pitchGoal - this.pitch) * Math.min(1, dt * 7);
    if (Math.abs(this.pitch - this.pitchGoal) < 0.01) this.pitch = this.pitchGoal;
    this.clampTarget();
  }
  clampTarget() {
    const [x0, z0, x1, z1] = this.bounds;
    this.dist = clamp(this.dist, this.minDist || CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    // 引いているときほど注視点を地図の外まで動かせる（画面の端に地図を寄せられるように）
    const m = 100 + this.dist * 0.5;
    this.tx = clamp(this.tx, x0 - m, x1 + m);
    this.tz = clamp(this.tz, z0 - m, z1 + m);
  }
  basis() {
    const p = this.pitch * Math.PI / 180, s = Math.sin(p), c = Math.cos(p);
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const eye = [this.tx + this.dist * c * sy, this.ty + this.dist * s, this.tz + this.dist * c * cy];
    const f = [-c * sy, -s, -c * cy], r = [cy, 0, -sy], u = [-s * sy, c, -s * cy];
    return { eye, f, r, u };
  }
  compute() {
    const { eye, f, r, u } = this.basis();
    const view = [
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -(r[0] * eye[0] + r[1] * eye[1] + r[2] * eye[2]),
      -(u[0] * eye[0] + u[1] * eye[1] + u[2] * eye[2]),
      (f[0] * eye[0] + f[1] * eye[1] + f[2] * eye[2]), 1];
    const aspect = this.w / this.h;
    const near = Math.max(this.nearMin || 0.5, this.dist * 0.05), far = this.dist * 6 + 500;
    const t = 1 / Math.tan(this.fovY / 2);
    const proj = [t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
    mat4mul(this.vp, proj, view);
    return this.vp;
  }
  /** 画面座標(CSS px) → 地面との交点 {x,z}（なければnull） */
  groundAt(sx, sy) {
    const { eye, f, r, u } = this.basis();
    const th = Math.tan(this.fovY / 2), aspect = this.w / this.h;
    const nx = (sx / this.w) * 2 - 1, ny = 1 - (sy / this.h) * 2;
    const d = [f[0] + r[0] * nx * th * aspect + u[0] * ny * th,
      f[1] + r[1] * nx * th * aspect + u[1] * ny * th,
      f[2] + r[2] * nx * th * aspect + u[2] * ny * th];
    if (d[1] > -1e-6) return null;
    const t = -eye[1] / d[1];
    return { x: eye[0] + d[0] * t, z: eye[2] + d[2] * t };
  }
  /** 地面の点 → 画面座標(CSS px) */
  project(x, y, z, out) {
    const m = this.vp;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (cw <= 0.0001) return null;
    out[0] = (cx / cw * 0.5 + 0.5) * this.w;
    out[1] = (0.5 - cy / cw * 0.5) * this.h;
    return out;
  }
  /** 画面中央付近での 1マスあたりのピクセル数 */
  cellPx() { return this.h / (2 * this.dist * Math.tan(this.fovY / 2)); }
  panBy(sx0, sy0, sx1, sy1) {
    const a = this.groundAt(sx0, sy0), b = this.groundAt(sx1, sy1);
    if (!a || !b) return;
    this.goal = null;
    this.tx += a.x - b.x; this.tz += a.z - b.z;
    this.clampTarget();
  }
  zoomAt(sx, sy, factor) {
    const before = this.groundAt(sx, sy);
    this.goal = null;
    this.dist = clamp(this.dist * factor, CONFIG.ZOOM_MIN, CONFIG.ZOOM_MAX);
    const after = this.groundAt(sx, sy);
    if (before && after) { this.tx += before.x - after.x; this.tz += before.z - after.z; }
    this.clampTarget();
  }
}
function mat4mul(out, a, b) {
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      out[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
  }
  return out;
}

// =====================================================================
// WebGL 描画
// =====================================================================
const GROUND_VS = `
attribute vec2 aPos;
uniform mat4 uVP;
varying vec2 vWorld;
void main(){ vWorld = aPos; gl_Position = uVP * vec4(aPos.x, 0.0, aPos.y, 1.0); }`;

// 地面：なめらかな地形の色 × 標高の陰影 × 細かいゆらぎ。海は岸に近いほど浅い色。
// 領土は「うっすら塗り」＋「国境線」（真上ビューでは濃く塗る）。
const GROUND_FS = `
#ifdef HAS_DERIV
#extension GL_OES_standard_derivatives : enable
#endif
precision highp float;
uniform sampler2D uElev;      // L=標高, A=周りの陸地の割合（浅瀬・海岸の判定）。1/4 の解像度
uniform sampler2D uOwner;     // 区画アトラス：L=持ち主, A=地形の種類×16＋（最近占領されたら8）
uniform sampler2D uInd;       // 区画の表：RG=アトラスの中の区画の位置, A=陸地を含む区画か
uniform sampler2D uPalette;   // 1行目=県の色, 2行目=地形の色
uniform vec2 uTiles;          // 区画の数（横・縦）
uniform vec2 uAtlas;          // アトラスの大きさ（px）
uniform float uElevScale;
uniform sampler2D uGrass;      // 緑の草の筋（くり返し）
uniform sampler2D uDry;        // 黄金色の枯れ草の筋（くり返し）
uniform float uHasGrass;
uniform vec2 uGrid;
uniform float uFill;
uniform float uMe;
uniform float uPlace;
uniform float uTime;
uniform float uCpp;
uniform float uScale;          // 1マスの細かさ（オンライン版は3：地形は元の地図のマス、持ち主は細かいマス）
uniform float uTS;             // 地形のかたまりの大きさ（お試し版は3：細かい地図の地形は元のマス3×3ずつ同じ）
uniform float uHasFine;
uniform sampler2D uFine;       // 細かい持ち主の区画（64×64マスずつ。L=持ち主＋最近占領なら64）
uniform sampler2D uFInd;       // 細かい区画の表：RG=区画の位置, A=受け取り済みか
uniform vec2 uFTiles;
uniform vec3 uEye;     // 三人称視点の霧（遠くを空の色に溶かす）
uniform vec3 uFog;     // x=始まり, y=終わり, z=有効か
uniform vec3 uFogCol;
varying vec2 vWorld;
vec3 fogged(vec3 c){
  if (uFog.z < 0.5) return c;
  float d = length(vec3(vWorld.x - uEye.x, uEye.y, vWorld.y - uEye.z));
  return mix(c, uFogCol, smoothstep(uFog.x, uFog.y, d) * 0.92);
}
float hash(vec2 p){ p = mod(p, 289.0); return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }   // 座標を折り返してから（大きな座標で縞が出ないように）
float noise(vec2 p){
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// マス → アトラスの中のデータ（x=持ち主, y=地形の種類, z=最近占領されたか）。
// 中心のマスの区画を覚えておき、同じ区画のマスは区画の表を引き直さない
vec2 gTile; vec2 gOrig; float gOk;
void setTile(vec2 cell){
  gTile = floor(cell / 64.0);
  vec4 ind = texture2D(uInd, (gTile + 0.5) / uTiles);
  gOk = ind.a; gOrig = floor(ind.rg * 255.0 + 0.5) * 64.0;
}
vec3 cellData(vec2 cell){
  vec2 t = floor(cell / 64.0);
  vec2 orig = gOrig; float ok = gOk;
  if (t != gTile) { vec4 ind = texture2D(uInd, (t + 0.5) / uTiles); ok = ind.a; orig = floor(ind.rg * 255.0 + 0.5) * 64.0; }
  if (ok < 0.5 || cell.x < 0.0 || cell.y < 0.0) return vec3(0.0);
  vec4 d = texture2D(uOwner, (orig + (cell - t * 64.0) + 0.5) / uAtlas);
  float a = floor(d.a * 255.0 + 0.5);
  return vec3(floor(d.r * 255.0 + 0.5), floor(a / 16.0), step(7.5, mod(a, 16.0)));
}
float landAt(vec2 tc){ return step(0.5, cellData(tc * uTS + floor(uTS * 0.5)).y); }
float terrAt(vec2 tc){ return cellData(tc * uTS + floor(uTS * 0.5)).y; }
// 細かいマスの持ち主（x=持ち主・まだ届いていなければ -1, y=最近占領されたか）
vec2 fineData(vec2 fc){
  vec2 t = floor(fc / 64.0);
  vec4 ind = texture2D(uFInd, (t + 0.5) / uFTiles);
  if (ind.a < 0.5 || fc.x < 0.0 || fc.y < 0.0) return vec2(-1.0, 0.0);
  vec2 orig = floor(ind.rg * 255.0 + 0.5) * 64.0;
  float v = floor(texture2D(uFine, (orig + fc - t * 64.0 + 0.5) / 2048.0).r * 255.0 + 0.5);
  return vec2(mod(v, 64.0), step(63.5, v));
}
float ownerAt(vec2 w){
  if (uHasFine > 0.5) { vec2 f = fineData(floor(w)); if (f.x >= 0.0) return f.x; }
  return cellData(floor(w / uScale)).x;
}
void main(){
#ifdef HAS_DERIV
  vec2 fw = fwidth(vWorld);
  float cpp = max(max(fw.x, fw.y), 1e-4);
#else
  float cpp = uCpp;
#endif
  vec2 uv = vWorld / uGrid;
  vec3 deep = vec3(0.10, 0.22, 0.32);   // 藍色がかった深い海
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) { gl_FragColor = vec4(fogged(deep), 1.0); return; }
  vec4 e = texture2D(uElev, uv);
  // 沖合（近くに陸地がない）は区画を読まずに海だけ描く
  if (e.a < 0.004) {
    vec3 w0 = deep + (noise(vWorld * 0.8 + vec2(uTime * 0.15, uTime * 0.07)) - 0.5) * 0.04;
    gl_FragColor = vec4(fogged(w0), 1.0); return;
  }
  // 地形：このマスの種類の色（高いところは岩の色に）＋ 4マスの陸／海をなめらかにつないで海岸線を丸く
  vec2 cw = vWorld / uScale;
  vec2 cell = floor(cw);
  setTile(cell);
  vec3 here = cellData(cell);
  float cls = here.y;
  // まわり4マスの地形の色を混ぜて、マスの角が見えないように（海のマスはこのマスの色で埋める）
  // 境目がマスの形（階段）に見えないよう、読む位置をゆらす（地形の色は大きく、海岸線は少しだけ）
  vec2 warp = vec2(noise(vWorld * 0.09 + 1.7), noise(vWorld * 0.09 - 5.3)) - 0.5;
  vec2 tw = cw / uTS;
  vec2 q = tw - 0.5 + warp * 0.9, qf = fract(q), q0 = floor(q);
  vec3 hc = texture2D(uPalette, vec2((cls + 0.5) / 64.0, 0.75)).rgb;
  float k00 = terrAt(q0), k10 = terrAt(q0 + vec2(1.0, 0.0)), k01 = terrAt(q0 + vec2(0.0, 1.0)), k11 = terrAt(q0 + vec2(1.0, 1.0));
  vec3 c00 = k00 > 0.5 ? texture2D(uPalette, vec2((k00 + 0.5) / 64.0, 0.75)).rgb : hc;
  vec3 c10 = k10 > 0.5 ? texture2D(uPalette, vec2((k10 + 0.5) / 64.0, 0.75)).rgb : hc;
  vec3 c01 = k01 > 0.5 ? texture2D(uPalette, vec2((k01 + 0.5) / 64.0, 0.75)).rgb : hc;
  vec3 c11 = k11 > 0.5 ? texture2D(uPalette, vec2((k11 + 0.5) / 64.0, 0.75)).rgb : hc;
  vec2 sf = smoothstep(0.0, 1.0, qf);
  vec3 tcol = cls > 0.5 ? mix(mix(c00, c10, sf.x), mix(c01, c11, sf.x), sf.y) : hc;
  if (cls > 0.5 && cls < 7.5) tcol = mix(tcol, vec3(0.49, 0.44, 0.36), clamp((e.r - 0.35) * 1.6, 0.0, 0.75));
  // 海岸線もまわり4マスの陸／海からなめらかに
  vec2 warp2 = vec2(noise(vWorld * 0.31 - 2.1), noise(vWorld * 0.31 + 8.4)) - 0.5;
  vec2 p2 = tw - 0.5 + warp * 0.5 + warp2 * 0.25 / uTS, pf = fract(p2), p0 = floor(p2);
  float landA = mix(mix(landAt(p0), landAt(p0 + vec2(1.0, 0.0)), pf.x), mix(landAt(p0 + vec2(0.0, 1.0)), landAt(p0 + vec2(1.0, 1.0)), pf.x), pf.y);
  vec4 t = vec4(tcol, landA);
  // 標高から陰影（北西から光）
  vec2 px = uElevScale / uGrid;
  float hL = texture2D(uElev, uv - vec2(px.x, 0.0)).r, hR = texture2D(uElev, uv + vec2(px.x, 0.0)).r;
  float hU = texture2D(uElev, uv - vec2(0.0, px.y)).r, hD = texture2D(uElev, uv + vec2(0.0, px.y)).r;
  vec3 n = normalize(vec3((hL - hR) * 9.0, 1.0, (hU - hD) * 9.0));
  float shade = clamp(0.68 + 0.45 * dot(n, normalize(vec3(-0.55, 0.75, -0.45))), 0.6, 1.2);   // 粗い標高のぼやけた影が目立ちすぎないよう控えめに
  // 草原らしい細かいゆらぎ（拡大すると見える）
  float zin = clamp(1.5 - cpp * 2.0, 0.0, 1.0);
  float nz = noise(vWorld * 0.35) * 0.45 + noise(vWorld * 1.6) * 0.35 + noise(vWorld * 6.0) * 0.2 * zin;
  // 拡大したときの草（細かいまだらと、暗い草の株）
  float fine = clamp(0.5 - cpp * 3.0, 0.0, 1.0);
  vec2 lw0 = mod(vWorld, 512.0);
  nz += (noise(lw0 * 17.0) - 0.5) * 0.35 * fine + (noise(lw0 * 41.0) - 0.5) * 0.25 * fine;
  vec3 land = t.rgb * (0.82 + 0.36 * nz);
  if (uHasGrass > 0.5) {
    // 草の筋の絵を2つの大きさで重ねて貼る（くり返しが目立たないように）
    // 引いたときも筋がつぶれて平らな色にならないよう、拡大率に合わせて絵の大きさを2倍ずつ切り替える（となりの段となめらかに混ぜる）
    float lod = max(-2.5, log2(cpp * 40.0));   // ごく近く（三人称視点）では絵を細かくくり返して、ぼやけないように
    float s0 = exp2(floor(lod)), lf = fract(lod);
    // 近くでは座標を小さく折り返す（大きな座標のままだと、絵を読む位置の精度が足りず縦横の線や段が出る）
    vec2 lw = s0 <= 1.0 ? mod(vWorld, 680.0) : vWorld;
    vec2 r2 = vec2(lw.y, -lw.x);
    vec2 w1 = lw / (5.0 * s0), w2 = r2 / (17.0 * s0) + 0.37;
    vec2 v1 = w1 * 0.5 + 0.13, v2 = w2 * 0.5 + 0.61;
    vec3 g = mix(texture2D(uGrass, w1).rgb * 0.6 + texture2D(uGrass, w2).rgb * 0.4, texture2D(uGrass, v1).rgb * 0.6 + texture2D(uGrass, v2).rgb * 0.4, lf);
    vec3 d = mix(texture2D(uDry, w1 * 0.9 + 0.21).rgb * 0.6 + texture2D(uDry, w2 * 1.1).rgb * 0.4, texture2D(uDry, v1 * 0.9 + 0.21).rgb * 0.6 + texture2D(uDry, v2 * 1.1).rgb * 0.4, lf);
    // 黄金色の枯れ草の帯（大きなむら。ふちはやわらかく）
    float m = noise(vWorld * 0.022 + 3.7) * 0.65 + noise(vWorld * 0.07 - 1.3) * 0.35;
    float dry = smoothstep(0.47, 0.6, m);
    vec3 grassCol = mix(g, d, dry);
    // 地形の色（平地＝緑、森＝濃い緑、岩、雪）に合わせて、草の絵の色を寄せる
    float plainLike = clamp(1.0 - distance(t.rgb, vec3(0.6, 0.66, 0.29)) * 3.0, 0.0, 1.0);
    vec3 tinted = grassCol * (t.rgb / vec3(0.5, 0.6, 0.23));
    land = mix(tinted * 0.86, grassCol * 1.06, plainLike) * (0.92 + 0.16 * nz);
    float lum = dot(land, vec3(0.299, 0.587, 0.114));
    land = mix(vec3(lum), land, 1.05);   // 彩度は控えめに（蛍光色のようにならないよう）
    // 道のように踏み固められた土の斑
    // 市街地：ぼやけた灰色の四角にならないよう、小さな屋根と道の区画をくっきり描く（拡大したときだけ）
    // 市街地の広がり：まわり4マスから求め（ゆらした位置）、ふちをなめらかに
    float cityK = smoothstep(0.35, 0.65, mix(mix(step(abs(k00 - 4.0), 0.5), step(abs(k10 - 4.0), 0.5), qf.x), mix(step(abs(k01 - 4.0), 0.5), step(abs(k11 - 4.0), 0.5), qf.x), qf.y));
    float cityZ = clamp(1.6 - cpp * 3.0, 0.0, 1.0) * cityK * smoothstep(0.03, 0.12, cpp);   // 三人称視点のようにごく近いときは描かない（四角い線に見えるので。家は立体で建っている）
    if (cityZ > 0.0 && uFog.z < 0.5) {   // 三人称視点では描かない（家は立体で建っているので、地面の四角はモザイクに見える）
      vec2 bw = vWorld * 1.6, bf = fract(bw), bi = floor(bw);
      float hb = hash(bi);
      float roof = step(0.16, bf.x) * step(bf.x, 0.86) * step(0.16, bf.y) * step(bf.y, 0.86) * step(0.3, hb);
      vec3 rc = hb > 0.7 ? vec3(0.36, 0.37, 0.42) : hb > 0.5 ? vec3(0.55, 0.32, 0.22) : vec3(0.62, 0.58, 0.5);
      land = mix(land, mix(vec3(0.66, 0.6, 0.48), rc, roof), 0.3 * cityZ * clamp(cpp * 6.0, 0.35, 1.0));
    }
  } else {
    float patch = noise(vWorld * 0.06 + 7.3), patch2 = noise(vWorld * 0.11 - 3.1);
    land = mix(land, vec3(0.6, 0.6, 0.3), smoothstep(0.66, 0.9, patch) * 0.22 * t.a);
    land = mix(land, t.rgb * vec3(0.72, 0.86, 0.66), smoothstep(0.55, 0.8, patch2) * 0.4);
  }
  land *= shade;
  // 流れる雲の影（大きくやわらかい影が、ゆっくり東へ動く）
  float cloud = noise(vWorld * 0.0045 / uScale + vec2(uTime * 0.012, uTime * 0.004)) * 0.7 + noise(vWorld * 0.011 / uScale - vec2(uTime * 0.02, 0.0)) * 0.3;
  land *= 1.0 - 0.16 * smoothstep(0.56, 0.74, cloud);
  // 海：岸に近いほど浅い色、さざ波
  // 浅瀬：8bitの値の段差が縞に見えないよう、細かいゆらぎ（ディザ）を足してからなめらかに
  float near = min(1.0, (e.a + (hash(floor(gl_FragCoord.xy)) - 0.5) / 255.0 * 1.5) * 2.2);
  near = smoothstep(0.0, 1.0, near);
  vec3 shallow = vec3(0.30, 0.50, 0.50);   // 岸の近くは青緑（浅葱）
  vec3 water = mix(deep, shallow, near * near);
  water += (noise(vWorld * 0.8 + vec2(uTime * 0.15, uTime * 0.07)) - 0.5) * 0.04;
  // 岸と平行な白い波の筋（浅いところだけ、ゆっくり寄せては返す）
  float wv = sin(near * 26.0 - uTime * 1.3 + noise(vWorld * 0.15) * 4.0);
  water += smoothstep(0.86, 1.0, wv) * smoothstep(0.25, 0.7, near) * (1.0 - smoothstep(0.85, 1.0, near)) * 0.09 * clamp(1.6 - uCpp * 1.2, 0.0, 1.0);   // 引いたときは出さない（画面1pxあたりのマス数で判断）
  float isLand = smoothstep(0.42, 0.58, t.a);
  float foam = smoothstep(0.25, 0.45, t.a) * (1.0 - isLand);
  vec3 col = mix(water + foam * 0.25, land, isLand);
  // 領土
  if (isLand > 0.01) {
    float id = here.x, rec = here.z;
    if (uHasFine > 0.5) { vec2 f = fineData(floor(vWorld)); if (f.x >= 0.0) { id = f.x; rec = f.y; } }
    if (id > 0.5) {
      vec3 pc = texture2D(uPalette, vec2((id + 0.5) / 64.0, 0.25)).rgb;
      col = mix(col, pc, uFill * isLand);
      // 国境線：となりの持ち主が違えば、自分の側に自分の色の線を引く
      // 引いているときは画面上で2pxくらい、拡大すると0.35マスの帯
      float w = max(0.35, cpp * 1.7);
      float edge = 0.0;
      float nearB = 1.0 - smoothstep(0.01, 0.06, cpp);
      if (nearB < 0.9 && uFog.z < 0.5) for (int k = 0; k < 4; k++) {   // 三人称視点では国境の線を描かない（ギザギザの線に見える。今いる領土は画面左上に出す）   // 三人称視点（ごく近く）では国境の線を調べない（重いので）
        vec2 o = k == 0 ? vec2(w, 0.0) : k == 1 ? vec2(-w, 0.0) : k == 2 ? vec2(0.0, w) : vec2(0.0, -w);
        float q = ownerAt(vWorld + o);
        if (q > 0.5 && abs(q - id) > 0.5) edge = 1.0;
      }
      float zoomedIn = clamp((1.0 / cpp - 3.0) / 6.0, 0.0, 1.0);
      float nearK = 1.0 - smoothstep(0.01, 0.06, cpp);   // 三人称視点：国境は地面にうっすら（マスの階段の線にならないよう）
      // 国境線：筆で引いたような強弱（場所でかすれる）と、墨の縁取り
      if (edge > 0.5) {
        float brush = 0.65 + 0.35 * noise(vWorld * 0.18 + 11.0);
        col = mix(col, pc * 0.95 + 0.06, (0.85 - 0.4 * zoomedIn) * isLand * brush * (1.0 - nearK * 0.8));
        col *= 1.0 - 0.18 * (1.0 - zoomedIn) * isLand;   // 引いているときは少し暗くして、地図の上でくっきり
      }
      // 最近占領されたところは斜線
      if (rec > 0.5 && nearK < 0.5) {
        float s = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 12.0));
        col = mix(col, pc, s * 0.35);
      }
      // 建設モード：自県の領土を明るく、それ以外を暗く
      if (uPlace > 0.0) col = abs(id - uMe) < 0.5 ? mix(col, vec3(0.75, 1.0, 0.6), 0.12) : col * 0.7;
    }
  }
  // ごく近く（三人称視点）：草の細かいむらと土の粒
  float closeK = 1.0 - smoothstep(0.01, 0.06, cpp);
  if (closeK > 0.0) {
    vec2 lc = mod(vWorld, 512.0);
    float n1 = noise(lc * 6.0), n2 = noise(lc * vec2(41.0, 9.0));
    col *= 1.0 + closeK * isLand * ((n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.18);
  }
  gl_FragColor = vec4(fogged(col), 1.0);
}`;

// 空（三人称視点）：地平線から上へ、もやの色 → 青空
const SKY_VS = `
attribute vec2 aPos;
varying float vY;
void main(){ vY = aPos.y; gl_Position = vec4(aPos, 0.999, 1.0); }`;
const SKY_FS = `
precision mediump float;
uniform float uHor;
uniform vec3 uTop;
uniform vec3 uHorC;
varying float vY;
void main(){
  float t = smoothstep(uHor, uHor + 1.6, vY);
  vec3 c = mix(uHorC, uTop, pow(t, 0.7));
  gl_FragColor = vec4(c, 1.0);
}`;

const LINE_VS = `
attribute vec2 aA;
attribute vec2 aB;
attribute vec3 aInfo; // side, end, dist
uniform mat4 uVP;
uniform vec2 uViewport;
uniform float uWidth;
varying float vDist;
void main(){
  vec4 pa = uVP * vec4(aA.x, 0.0, aA.y, 1.0);
  vec4 pb = uVP * vec4(aB.x, 0.0, aB.y, 1.0);
  vec4 p = aInfo.y < 0.5 ? pa : pb;
  vec2 sa = pa.xy / pa.w * uViewport, sb = pb.xy / pb.w * uViewport;
  vec2 d = sb - sa;
  float L = length(d);
  d = L > 1e-5 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  p.xy += n * aInfo.x * uWidth / uViewport * p.w;
  gl_Position = p;
  vDist = aInfo.z;
}`;
const LINE_FS = `
precision mediump float;
uniform vec4 uColor;
uniform float uDash;
varying float vDist;
void main(){
  if (uDash > 0.0 && fract(vDist / uDash) > 0.55) discard;
  gl_FragColor = uColor;
}`;

// 建物・兵士・木：メッシュ（箱・屋根・円錐・円柱）をインスタンスごとに 位置・大きさ・色・向き で描く
const MESH_VS = `
attribute vec3 aPos;
attribute vec3 aNrm;
attribute vec3 iOff;
attribute vec3 iScale;
attribute vec4 iColor;   // rgb + 向き(ラジアン)
attribute float iTilt;   // 横軸まわりの傾き（手足の振り・倒れた姿など）
uniform mat4 uVP;
varying vec3 vN;
varying vec3 vC;
varying vec3 vL;    // 部品の中の位置（ワールドの長さ。模様の細かさをそろえるため）
varying vec3 vW;    // ワールド座標（模様のゆらぎ用）
void main(){
  float c = cos(iColor.w), s = sin(iColor.w);
  vec3 p = aPos * iScale;
  vL = p;
  float ct = cos(iTilt), st = sin(iTilt);
  p = vec3(p.x, ct * p.y - st * p.z, st * p.y + ct * p.z);
  vec3 nn = vec3(aNrm.x, ct * aNrm.y - st * aNrm.z, st * aNrm.y + ct * aNrm.z);
  p = vec3(c * p.x - s * p.z, p.y, s * p.x + c * p.z);
  vN = vec3(c * nn.x - s * nn.z, nn.y, s * nn.x + c * nn.z);
  vC = iColor.rgb;
  vW = p + iOff;
  gl_Position = uVP * vec4(p + iOff, 1.0);
}`;
const MESH_FS = `
precision mediump float;
uniform float uAlpha;   // 影は半透明
uniform float uFlat;    // 影・地面の敷物は陰影をつけない
uniform float uMat;     // 表面の模様 0:なし 1:屋根(瓦・茅) 2:壁(板目) 3:針葉樹 4:広葉樹 5:幹・柱(木目) 6:土の敷物
uniform float uDetail;  // 拡大したときだけ模様を出す（0..1）
uniform vec3 uEye;
uniform vec3 uFog;
uniform vec3 uFogCol;
varying vec3 vN;
varying vec3 vC;
varying vec3 vL;
varying vec3 vW;
float h21(vec2 p){ p = mod(p, 289.0); return fract(sin(dot(p, vec2(41.3, 289.1))) * 15731.7); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y); }
void main(){
  vec3 n = normalize(vN);
  vec2 wz = mod(vW.xz, 256.0);   // 模様は小さく折り返した座標で（大きな座標だと精度が足りず縞になる）
  vec3 c = vC;
  float d = uDetail;
  if (d > 0.01) {
    if (uMat < 1.5) {
      // 屋根：段になった瓦・茅の筋と、細かいざらつき
      float row = fract(vL.y * 9.0);
      c *= 1.0 - d * (0.22 * smoothstep(0.75, 1.0, row) + 0.1 * vn(wz * 30.0 + vL.y * 20.0));
      if (uMat > 0.5 && abs(n.y) < 0.3) c *= 1.0 - 0.12 * d;
    } else if (uMat < 2.5) {
      // 壁：縦の板目と、柱・梁の帯（上面は少し明るく）
      if (abs(n.y) < 0.5) {
        float u = abs(n.x) > abs(n.z) ? vL.z : vL.x;
        float plank = smoothstep(0.85, 1.0, fract(u * 11.0));
        float beam = smoothstep(0.9, 1.0, fract(vL.y * 3.2));
        c *= 1.0 - d * (0.16 * plank + 0.22 * beam + 0.08 * vn(wz * 22.0 + vL.y * 9.0));
      } else c *= 1.0 + 0.06 * d;
    } else if (uMat < 3.5) {
      // 針葉樹：枝の段
      c *= 1.0 - d * (0.28 * smoothstep(0.55, 1.0, fract(vL.y * 4.5)) + 0.18 * vn(wz * 18.0 + vL.y * 7.0));
    } else if (uMat < 4.5) {
      // 広葉樹：葉のかたまり
      float k = vn(wz * 12.0 + vW.y * 9.0) * 0.6 + vn(wz * 31.0 - vW.y * 17.0) * 0.4;
      c *= 0.72 + 0.5 * k * d + (1.0 - d) * 0.28;
    } else if (uMat < 5.5) {
      float u = abs(n.x) > abs(n.z) ? vL.z : vL.x;
      c *= 1.0 - d * 0.2 * vn(vec2(u * 40.0, vL.y * 4.0));
    } else {
      // 土の敷物：まだら
      c *= 0.86 + 0.24 * vn(wz * 6.0) * (0.4 + 0.6 * d);
    }
  }
  // 光は手前左上から（見えている壁が明るくなるように）
  float l = 0.45 + 0.62 * max(dot(n, normalize(vec3(-0.45, 0.8, 0.5))), 0.0) + 0.06 * n.y;
  vec3 oc = mix(c * l, c, uFlat);
  if (uFog.z > 0.5) oc = mix(oc, uFogCol, smoothstep(uFog.x, uFog.y, length(vW - uEye)) * 0.92);
  gl_FragColor = vec4(oc, uAlpha);
}`;
const INST_FLOATS = 11;
/** インスタンスの種類 → 表面の模様（名前の大文字以降は同じ形で模様違い：boxW=板目の箱 など） */
const MESH_MAT = { roof: 1, boxW: 2, coneT: 3, sphereT: 4, cylW: 5, pad: 6, roofT: 1 };

function compile(gl, vs, fs, defs) {
  const mk = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  const v = mk(gl.VERTEX_SHADER, vs), f = mk(gl.FRAGMENT_SHADER, (defs || '') + fs);
  gl.attachShader(p, v); gl.attachShader(p, f);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.deleteShader(v); gl.deleteShader(f);
  const u = {}, a = {};
  const nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
  const na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) { const info = gl.getActiveAttrib(p, i); a[info.name] = gl.getAttribLocation(p, info.name); }
  return { p, u, a };
}

/** メッシュの形（底面中心が原点、高さ1、幅1） */
function buildMeshes() {
  const meshes = {};
  const tri = (out, a, b, c) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1; nx /= L; ny /= L; nz /= L;
    for (const p of [a, b, c]) out.push(p[0], p[1], p[2], nx, ny, nz);
  };
  const quad = (out, a, b, c, d) => { tri(out, a, b, c); tri(out, a, c, d); };
  // 箱
  const box = [];
  const h = 0.5;
  quad(box, [-h, 1, -h], [-h, 1, h], [h, 1, h], [h, 1, -h]);
  quad(box, [-h, 0, h], [h, 0, h], [h, 1, h], [-h, 1, h]);
  quad(box, [h, 0, -h], [-h, 0, -h], [-h, 1, -h], [h, 1, -h]);
  quad(box, [h, 0, h], [h, 0, -h], [h, 1, -h], [h, 1, h]);
  quad(box, [-h, 0, -h], [-h, 0, h], [-h, 1, h], [-h, 1, -h]);
  meshes.box = box;
  // 切妻屋根（x 方向に棟）
  const roof = [];
  quad(roof, [-h, 0, h], [h, 0, h], [h, 1, 0], [-h, 1, 0]);
  quad(roof, [h, 0, -h], [-h, 0, -h], [-h, 1, 0], [h, 1, 0]);
  tri(roof, [h, 0, h], [h, 0, -h], [h, 1, 0]);
  tri(roof, [-h, 0, -h], [-h, 0, h], [-h, 1, 0]);
  meshes.roof = roof;
  // 円錐（木の葉・塔の屋根）と円柱
  const cone = [], cyl = [], K = 8;
  for (let k = 0; k < K; k++) {
    const a0 = k / K * Math.PI * 2, a1 = (k + 1) / K * Math.PI * 2;
    const p0 = [Math.cos(a0) * h, 0, Math.sin(a0) * h], p1 = [Math.cos(a1) * h, 0, Math.sin(a1) * h];
    tri(cone, p1, p0, [0, 1, 0]);
    quad(cyl, p1, p0, [p0[0], 1, p0[2]], [p1[0], 1, p1[2]]);
    tri(cyl, [0, 1, 0], [p1[0], 1, p1[2]], [p0[0], 1, p0[2]]);
  }
  meshes.cone = cone;
  meshes.cyl = cyl;
  // 球（底が y=0、高さ1）：ドーム・広葉樹の葉・サイロの屋根
  const sph = [], ST = 6, SL = 10;
  const sp = (i, j) => { const th = i / ST * Math.PI, ph = j / SL * Math.PI * 2; return [Math.sin(th) * Math.cos(ph) * h, 0.5 + Math.cos(th) * h, Math.sin(th) * Math.sin(ph) * h]; };
  for (let i = 0; i < ST; i++) for (let j = 0; j < SL; j++) {
    const a = sp(i, j), b = sp(i + 1, j), c = sp(i + 1, j + 1), d = sp(i, j + 1);
    // 球は面の法線ではなく中心からの向きを法線にする（なめらかに見える）
    for (const p of [a, b, c, a, c, d]) { const nx = p[0], ny = p[1] - 0.5, nz = p[2], L = Math.hypot(nx, ny, nz) || 1; sph.push(p[0], p[1], p[2], nx / L, ny / L, nz / L); }
  }
  meshes.sphere = sph;
  return meshes;
}

class Renderer {
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGLが使えません');
    this.gl = gl;
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    const deriv = gl.getExtension('OES_standard_derivatives');
    const hp = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
    let fs = GROUND_FS;
    if (!hp || hp.precision === 0) fs = fs.replace('precision highp float;', 'precision mediump float;');
    this.ground = compile(gl, GROUND_VS, fs, deriv ? '#define HAS_DERIV\n' : '');
    this.line = compile(gl, LINE_VS, LINE_FS);
    const hi = (src) => (hp && hp.precision > 0 ? src.replace('precision mediump float;', 'precision highp float;') : src);   // スマホでも細かい模様がつぶれないように
    this.mesh = compile(gl, MESH_VS, hi(MESH_FS));
    this.sprite = compile(gl, SPRITE_VS, hi(SPRITE_FS));
    this.sky = compile(gl, SKY_VS, SKY_FS);
    this.skyBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.spriteBuf = gl.createBuffer();
    this.spriteQuad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteQuad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.5, 0, 0.5, 0, -0.5, 1, 0.5, 0, 0.5, 1, -0.5, 1]), gl.STATIC_DRAW);
    this.grassTex = gl.createTexture();
    this.dryTex = gl.createTexture();
    this.spriteColor = gl.createTexture();
    this.spriteMask = gl.createTexture();
    this.instExt = gl.getExtension('ANGLE_instanced_arrays');
    this.instBuf = gl.createBuffer();
    this.dirty = new Set();
    this.texel = new Uint8Array(4);
    this.me = 0;
    this.game = null;
    this.buildGround();
    this.buildLines();
    this.meshBufs = {};
    for (const [k, v] of Object.entries(buildMeshes())) {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
      this.meshBufs[k] = { buf: b, count: v.length / 6 };
    }
    this.palette = gl.createTexture();
    this.ownerTex = gl.createTexture();
    this.terrainTex = gl.createTexture();
    this.elevTex = gl.createTexture();
    this.indTex = gl.createTexture();
  }
  dispose() {
    const gl = this.gl;
    for (const t of [this.palette, this.ownerTex, this.terrainTex, this.elevTex, this.indTex, this.spriteColor, this.spriteMask, this.grassTex, this.dryTex]) gl.deleteTexture(t);
    for (const b of [this.spriteBuf, this.spriteQuad]) gl.deleteBuffer(b);
    gl.deleteProgram(this.sprite.p);
    for (const b of [this.groundBuf, this.lineBuf, this.instBuf]) gl.deleteBuffer(b);
    for (const m of Object.values(this.meshBufs)) gl.deleteBuffer(m.buf);
    for (const p of [this.ground, this.line, this.mesh]) gl.deleteProgram(p.p);
  }
  texParams(gl, linear) {
    const f = linear ? gl.LINEAR : gl.NEAREST;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }
  /**
   * 区画アトラス：陸地を含む 64×64 マスの区画を、横 64 個ずつ並べた 1 枚の絵（4096 × 64・行数）。
   * マスの番号 i の区画 t = i>>12 は、アトラスの (t%64, t/64) 番目に置く。
   */
  atlasPos(i) {
    const t = i >> 12;
    return [((t & 63) << 6) + (i & 63), ((t >> 6) << 6) + ((i >> 6) & 63)];
  }
  /** 区画方式の配列（1マス k バイト）を、アトラスの並びのバイト列に並べ替える */
  toAtlas(fn, k) {
    const map = this.map, AW = this.AW, AH = this.AH;
    const out = new Uint8Array(AW * AH * k);
    for (let t = 0; t < map.nTiles; t++) {
      const ax = (t & 63) << 6, ay = (t >> 6) << 6, base = t << 12;
      for (let ly = 0; ly < 64; ly++) {
        let o = ((ay + ly) * AW + ax) * k;
        for (let lx = 0; lx < 64; lx++, o += k) fn(base + (ly << 6) + lx, out, o);
      }
    }
    return out;
  }
  /** 区画の表・標高と浅瀬のテクスチャ（地形の種類は持ち主と同じアトラスに入れる） */
  uploadTerrain() {
    const { gl, map } = this;
    this.AW = 4096; this.AH = Math.max(64, Math.ceil(map.nTiles / 64) * 64);
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
    if (this.AH > maxTex || this.AW > maxTex) throw new Error(`この端末はテクスチャサイズ ${maxTex} までしか扱えません`);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // 区画の表（TW×TH）：アトラスの中の位置
    const ind = new Uint8Array(map.TW * map.TH * 4);
    for (let k = 0; k < map.TW * map.TH; k++) {
      const b = map.tileBase[k];
      if (b < 0) continue;
      const t = b >> 12;
      ind[k * 4] = t & 63; ind[k * 4 + 1] = t >> 6; ind[k * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.indTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, map.TW, map.TH, 0, gl.RGBA, gl.UNSIGNED_BYTE, ind);
    this.texParams(gl, false);
    // 標高(L) と 陸地への近さ(A)（1/4 の解像度。ぼかして浅瀬の幅にする）
    const ew = map.elevW, eh = map.elevH, elev = map.elev, k = map.elevScale;
    const near = new Float32Array(ew * eh);
    for (let y = 0; y < eh; y++) for (let x = 0; x < ew; x++) {
      const i = map.id(x * k + (k >> 1), y * k + (k >> 1));
      near[y * ew + x] = i >= 0 && map.initPref[i] ? 1 : 0;
    }
    const blur = (src, r) => {
      const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
      for (let y = 0; y < eh; y++) { let s = 0; for (let x = -r; x < ew + r; x++) { if (x + r < ew) s += src[y * ew + x + r]; if (x - r - 1 >= 0) s -= src[y * ew + x - r - 1]; if (x >= 0 && x < ew) tmp[y * ew + x] = s / (2 * r + 1); } }
      for (let x = 0; x < ew; x++) { let s = 0; for (let y = -r; y < eh + r; y++) { if (y + r < eh) s += tmp[(y + r) * ew + x]; if (y - r - 1 >= 0) s -= tmp[(y - r - 1) * ew + x]; if (y >= 0 && y < eh) out[y * ew + x] = s / (2 * r + 1); } }
      return out;
    };
    const nb = blur(blur(near, 5), 5);
    const la = new Uint8Array(ew * eh * 2);
    for (let q = 0; q < ew * eh; q++) { la[q * 2] = elev[q]; la[q * 2 + 1] = Math.round(Math.min(1, nb[q]) * 255); }   // 周りの陸地の割合
    gl.bindTexture(gl.TEXTURE_2D, this.elevTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, ew, eh, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, la);
    this.texParams(gl, true);
  }
  /** 草の筋の絵（GroundPainter）を、くり返し貼れるテクスチャにする */
  uploadGround(gp) {
    const gl = this.gl;
    for (const [tex, cv] of [[this.grassTex, gp.grass], [this.dryTex, gp.dry]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    }
    this.hasGrass = true;
  }
  /** 兵士の絵（SoldierPainter）をテクスチャにする。縮小してもきれいなようにミップマップ付き */
  uploadSprites(painter) {
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    for (const [tex, cv, fmt] of [[this.spriteColor, painter.color, gl.RGBA], [this.spriteMask, painter.mask, gl.LUMINANCE]]) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, fmt, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.spriteSize = [painter.w, painter.h];
    this.hasSprites = true;
  }
  /** 色の表：1行目＝県の色、2行目＝地形の色 */
  setPalette(colors) {
    const gl = this.gl;
    const data = new Uint8Array(64 * 2 * 4);
    colors.forEach((c, i) => { if (c) { const [r, g, b] = hexToRgb(c); data.set([r, g, b, 255], i * 4); } });
    for (const k in TERRAIN_COLORS) data.set([...TERRAIN_COLORS[k], 255], (64 + +k) * 4);
    data.set([40, 90, 110, 255], 64 * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.palette);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 64, 2, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl, false);
  }
  /** 持ち主テクスチャ（1マス2バイト）: L=持ち主, A=255 なら最近占領されたマス */
  attachGame(game, me) {
    this.game = game; this.me = me;
    this.dirty.clear();
    const { gl } = this;
    const data = this.toAtlas((i, out, o) => this.computeTexel(i, out, o), 2);
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, this.AW, this.AH, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, data);
    this.texParams(gl, false);
  }
  /** 1マス2バイト：持ち主、地形の種類×16＋（最近占領されたら8） */
  computeTexel(i, out, o) {
    const g = this.game, map = this.map;
    out[o] = g ? g.owner[i] : map.initPref[i];
    out[o + 1] = (map.terrain[i] << 4) | (g && g.isRecent(i) ? 8 : 0);
  }
  cellChanged(i) { this.dirty.add(i); }
  /** 区画1つ（元の地図の区画の通し番号）をまとめて描き直す */
  tileChanged(t) {
    const { gl } = this;
    const out = this.tileBuf || (this.tileBuf = new Uint8Array(4096 * 2));
    for (let k = 0; k < 4096; k++) this.computeTexel((t << 12) + k, out, k * 2);
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (t & 63) << 6, (t >> 6) << 6, 64, 64, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, out);
  }
  /** 細かい持ち主の層（オンライン版）：2048×2048 に 64×64 の区画を 1024 個まで置く */
  initFine(TW, TH) {
    const { gl } = this;
    this.fineTW = TW; this.fineTH = TH;
    if (!this.fineTex) { this.fineTex = gl.createTexture(); this.fIndTex = gl.createTexture(); }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.fineTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, 2048, 2048, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, null);
    this.texParams(gl, false);
    gl.bindTexture(gl.TEXTURE_2D, this.fIndTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, TW, TH, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(TW * TH * 4));
    this.texParams(gl, false);
    this.fineSlot = new Map();
    this.fineFree = [];
    for (let k = 1023; k >= 0; k--) this.fineFree.push(k);
    this.hasFine = true;
  }
  setFineTile(t, bytes) {
    if (!this.hasFine) return;
    const { gl } = this;
    let s = this.fineSlot.get(t);
    if (s === undefined) {
      if (!this.fineFree.length) { const [old] = this.fineSlot.keys(); this.dropFine(old); }
      s = this.fineFree.pop();
      this.fineSlot.set(t, s);
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.fineTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, (s & 31) << 6, (s >> 5) << 6, 64, 64, gl.LUMINANCE, gl.UNSIGNED_BYTE, bytes);
    gl.bindTexture(gl.TEXTURE_2D, this.fIndTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, t % this.fineTW, (t / this.fineTW) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([s & 31, s >> 5, 0, 255]));
  }
  dropFine(t) {
    if (!this.hasFine) return;
    const s = this.fineSlot.get(t);
    if (s === undefined) return;
    this.fineSlot.delete(t); this.fineFree.push(s);
    const { gl } = this;
    gl.bindTexture(gl.TEXTURE_2D, this.fIndTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, t % this.fineTW, (t / this.fineTW) | 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  }
  flush() {
    if (!this.dirty.size) return;
    const { gl, map } = this;
    if (this.dirty.size > 20000) { const g = this.game; this.dirty.clear(); this.attachGame(g, this.me); return; }
    gl.bindTexture(gl.TEXTURE_2D, this.ownerTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    for (const i of this.dirty) {
      this.computeTexel(i, this.texel, 0);
      const [ax, ay] = this.atlasPos(i);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, ax, ay, 1, 1, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE, this.texel);
    }
    this.dirty.clear();
  }
  buildGround() {
    const gl = this.gl, { W, H } = this.map;
    const m = 6000 * (this.map.scale || 1);
    const v = new Float32Array([-m, -m, W + m, -m, -m, H + m, W + m, H + m]);
    this.groundBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
  }
  /** 連絡線（橋・トンネル・航路）とインセット枠 */
  buildLines() {
    const gl = this.gl, map = this.map;
    const verts = [];
    this.lineGroups = {};
    const pushSeg = (ax, ay, bx, by, d0, d1) => {
      const q = [[-1, 0, d0], [1, 0, d0], [-1, 1, d1], [1, 0, d0], [1, 1, d1], [-1, 1, d1]];
      for (const [side, end, d] of q) verts.push(ax, ay, bx, by, side, end, d);
    };
    const group = (name, fn) => { const start = verts.length / 7; fn(); this.lineGroups[name] = [start, verts.length / 7 - start]; };
    const polyline = (pts) => {
      let d = 0;
      for (let i = 0; i + 3 < pts.length; i += 2) {
        const L = Math.hypot(pts[i + 2] - pts[i], pts[i + 3] - pts[i + 1]);
        pushSeg(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], d, d + L);
        d += L;
      }
    };
    const c = (i) => [map.X(i) + 0.5, map.Y(i) + 0.5];
    this.linkStubs = [];
    group('links', () => {
      for (const l of map.raw.links) {
        const [ax, ay] = c(l.a), [bx, by] = c(l.b);
        const L = Math.hypot(bx - ax, by - ay);
        if (l.stub) {
          const ux = (bx - ax) / L, uy = (by - ay) / L, s = 45;
          pushSeg(ax, ay, ax + ux * s, ay + uy * s, 0, s);
          pushSeg(bx, by, bx - ux * s, by - uy * s, 0, s);
          this.linkStubs.push({ x: ax + ux * s, y: ay + uy * s, name: l.name });
          this.linkStubs.push({ x: bx - ux * s, y: by - uy * s, name: l.name });
        } else pushSeg(ax, ay, bx, by, 0, L);
      }
    });
    group('inset', () => { for (const r of map.raw.insets) polyline(r.poly); });
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  }
  resize(w, h, dpr) {
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
  }
  /** opt: { fill, place, time, meshes: { box|roof|cone|cyl: {data, count} } } */
  render(cam, opt) {
    const gl = this.gl, map = this.map;
    this.flush();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const fog = opt.fog, fc = fog ? fog.col : null;
    if (fog) gl.clearColor(fc[0], fc[1], fc[2], 1); else gl.clearColor(0.10, 0.22, 0.32, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const vp = cam.compute();
    const eyeB = cam.basis().eye;
    const setFog = (P) => {
      if (!P.u.uFog) return;
      gl.uniform3f(P.u.uFog, fog ? fog.start : 0, fog ? fog.end : 1, fog ? 1 : 0);
      if (fog) { gl.uniform3f(P.u.uEye, eyeB[0], eyeB[1], eyeB[2]); gl.uniform3f(P.u.uFogCol, fc[0], fc[1], fc[2]); }
    };
    if (fog) {   // 空
      const K = this.sky;
      gl.useProgram(K.p); gl.disable(gl.DEPTH_TEST);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.skyBuf);
      gl.enableVertexAttribArray(K.a.aPos);
      gl.vertexAttribPointer(K.a.aPos, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(K.u.uHor, Math.tan(cam.pitch * Math.PI / 180) / Math.tan(cam.fovY / 2));
      gl.uniform3f(K.u.uTop, fog.top[0], fog.top[1], fog.top[2]);
      gl.uniform3f(K.u.uHorC, fc[0], fc[1], fc[2]);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(K.a.aPos);
    }
    // --- 地面
    const g = this.ground;
    gl.useProgram(g.p);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.groundBuf);
    gl.enableVertexAttribArray(g.a.aPos);
    gl.vertexAttribPointer(g.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(g.u.uVP, false, vp);
    const tex = [[this.elevTex, 'uElev'], [this.ownerTex, 'uOwner'], [this.palette, 'uPalette'], [this.grassTex, 'uGrass'], [this.dryTex, 'uDry'], [this.indTex, 'uInd'],
      [this.fineTex || this.indTex, 'uFine'], [this.fIndTex || this.indTex, 'uFInd']];
    tex.forEach(([t, name], k) => { gl.activeTexture(gl.TEXTURE0 + k); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(g.u[name], k); });
    gl.uniform2f(g.u.uGrid, map.W, map.H);
    gl.uniform2f(g.u.uTiles, map.TW, map.TH);
    gl.uniform1f(g.u.uScale, map.texScale || 1);
    gl.uniform1f(g.u.uTS, map.terrScale || 1);
    gl.uniform1f(g.u.uHasFine, this.hasFine ? 1 : 0);
    gl.uniform2f(g.u.uFTiles, this.fineTW || 1, this.fineTH || 1);
    gl.uniform2f(g.u.uAtlas, this.AW, this.AH);
    gl.uniform1f(g.u.uElevScale, map.elevScale);
    gl.uniform1f(g.u.uFill, opt.fill);
    gl.uniform1f(g.u.uHasGrass, this.hasGrass ? 1 : 0);
    gl.uniform1f(g.u.uMe, this.me);
    gl.uniform1f(g.u.uPlace, opt.place ? 1 : 0);
    gl.uniform1f(g.u.uTime, opt.time || 0);
    if (g.u.uCpp) gl.uniform1f(g.u.uCpp, 1 / cam.cellPx());
    setFog(g);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disableVertexAttribArray(g.a.aPos);
    // --- 連絡線・インセット枠（地図の上の線。三人称視点では描かない：カメラの近くで線が画面を横切ってしまうため）
    const L = this.line, cpp = 1 / cam.cellPx();
    if (!fog) {
    gl.useProgram(L.p);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    for (const k of ['aA', 'aB', 'aInfo']) gl.enableVertexAttribArray(L.a[k]);
    gl.vertexAttribPointer(L.a.aA, 2, gl.FLOAT, false, 28, 0);
    gl.vertexAttribPointer(L.a.aB, 2, gl.FLOAT, false, 28, 8);
    gl.vertexAttribPointer(L.a.aInfo, 3, gl.FLOAT, false, 28, 16);
    gl.uniformMatrix4fv(L.u.uVP, false, vp);
    gl.uniform2f(L.u.uViewport, this.canvas.width / 2, this.canvas.height / 2);
    const dpr = this.canvas.width / cam.w;
    const draw = (grp, width, rgba, dashPx) => {
      const [s, n] = this.lineGroups[grp];
      if (!n) return;
      gl.uniform1f(L.u.uWidth, width * dpr * 0.5);
      gl.uniform4f(L.u.uColor, rgba[0], rgba[1], rgba[2], rgba[3]);
      gl.uniform1f(L.u.uDash, dashPx ? dashPx * cpp : 0);
      gl.drawArrays(gl.TRIANGLES, s, n);
    };
    draw('links', 3.0, [0.25, 0.15, 0.05, 0.6], 12);
    draw('links', 1.8, [1, 0.88, 0.45, 1], 12);
    draw('inset', 1.5, [1, 1, 1, 0.5], 10);
    for (const k of ['aA', 'aB', 'aInfo']) gl.disableVertexAttribArray(L.a[k]);
    gl.disable(gl.BLEND);
    }
    // --- 建物・兵士・木（インスタンス描画）。先に半透明の影、つぎに本体
    const meshes = opt.meshes;
    if (meshes) {
      const M = this.mesh, ext = this.instExt;
      gl.useProgram(M.p);
      gl.uniformMatrix4fv(M.u.uVP, false, vp);
      const attrs = [[M.a.iOff, 3, 0], [M.a.iScale, 3, 12], [M.a.iColor, 4, 24], [M.a.iTilt, 1, 40]];
      // 地面に敷くもの（土の敷物 → 影）を先に、つぎに立体
      const rank = (n) => (n === 'pad' ? 0 : n === 'shadow' ? 1 : 2);
      const order = Object.keys(meshes).sort((a, b) => rank(a) - rank(b));
      gl.uniform1f(M.u.uDetail, clamp((cam.cellPx() - 4) / 10, 0, 1));
      setFog(M);
      for (const name of order) {
        const inst = meshes[name];
        if (!inst || !inst.count) continue;
        const flat = name === 'shadow' || name === 'pad';
        if (flat) {
          gl.disable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
          gl.uniform1f(M.u.uAlpha, name === 'pad' ? 0.85 : 0.28); gl.uniform1f(M.u.uFlat, 1);
        } else {
          if (!this._solid) { gl.disable(gl.BLEND); gl.enable(gl.DEPTH_TEST); gl.clear(gl.DEPTH_BUFFER_BIT); this._solid = true; }
          gl.uniform1f(M.u.uAlpha, 1); gl.uniform1f(M.u.uFlat, 0);
        }
        const base = name.replace(/[A-Z].*$/, '');   // roofT → roof など（模様だけ違う同じ形）
        gl.uniform1f(M.u.uMat, MESH_MAT[name] || 0);
        const mb = this.meshBufs[flat ? 'cyl' : base];
        gl.bindBuffer(gl.ARRAY_BUFFER, mb.buf);
        gl.enableVertexAttribArray(M.a.aPos); gl.enableVertexAttribArray(M.a.aNrm);
        gl.vertexAttribPointer(M.a.aPos, 3, gl.FLOAT, false, 24, 0);
        gl.vertexAttribPointer(M.a.aNrm, 3, gl.FLOAT, false, 24, 12);
        if (ext) {
          gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
          gl.bufferData(gl.ARRAY_BUFFER, inst.data.subarray(0, inst.count * INST_FLOATS), gl.DYNAMIC_DRAW);
          for (const [a, n, off] of attrs) {
            gl.enableVertexAttribArray(a);
            gl.vertexAttribPointer(a, n, gl.FLOAT, false, INST_FLOATS * 4, off);
            ext.vertexAttribDivisorANGLE(a, 1);
          }
          ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, mb.count, inst.count);
          for (const [a] of attrs) { ext.vertexAttribDivisorANGLE(a, 0); gl.disableVertexAttribArray(a); }
        } else {
          const d = inst.data;
          for (let k = 0; k < inst.count; k++) {
            const o = k * INST_FLOATS;
            gl.vertexAttrib3f(attrs[0][0], d[o], d[o + 1], d[o + 2]);
            gl.vertexAttrib3f(attrs[1][0], d[o + 3], d[o + 4], d[o + 5]);
            gl.vertexAttrib4f(attrs[2][0], d[o + 6], d[o + 7], d[o + 8], d[o + 9]);
            gl.vertexAttrib1f(attrs[3][0], d[o + 10]);
            gl.drawArrays(gl.TRIANGLES, 0, mb.count);
          }
        }
        gl.disableVertexAttribArray(M.a.aPos); gl.disableVertexAttribArray(M.a.aNrm);
      }
      this._solid = false;
      gl.disable(gl.DEPTH_TEST); gl.disable(gl.BLEND);
    }
    // --- 兵士のスプライト（建物の陰に隠れるよう、深度テストあり）
    const sp = opt.sprites;
    if (sp && sp.count && this.hasSprites) {
      const Sx = this.sprite, ext = this.instExt;
      gl.useProgram(Sx.p);
      gl.enable(gl.DEPTH_TEST);
      if (!meshes) gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(Sx.u.uVP, false, vp);
      const b = cam.basis();
      gl.uniform3f(Sx.u.uRight, b.r[0], b.r[1], b.r[2]);
      gl.uniform3f(Sx.u.uUp, b.u[0], b.u[1], b.u[2]);
      gl.uniform1f(Sx.u.uFoot, (SPR.FH - SPR.FOOT) / SPR.FH);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.spriteColor); gl.uniform1i(Sx.u.uColor, 0);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.spriteMask); gl.uniform1i(Sx.u.uMask, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteQuad);
      gl.enableVertexAttribArray(Sx.a.aCorner);
      gl.vertexAttribPointer(Sx.a.aCorner, 2, gl.FLOAT, false, 0, 0);
      const attrs = [[Sx.a.iPos, 3, 0], [Sx.a.iSize, 2, 12], [Sx.a.iUV, 4, 20], [Sx.a.iTeam, 3, 36]];
      if (ext) {
        gl.bindBuffer(gl.ARRAY_BUFFER, this.spriteBuf);
        gl.bufferData(gl.ARRAY_BUFFER, sp.data.subarray(0, sp.count * SPRITE_FLOATS), gl.DYNAMIC_DRAW);
        for (const [a, n, off] of attrs) { gl.enableVertexAttribArray(a); gl.vertexAttribPointer(a, n, gl.FLOAT, false, SPRITE_FLOATS * 4, off); ext.vertexAttribDivisorANGLE(a, 1); }
        ext.drawArraysInstancedANGLE(gl.TRIANGLES, 0, 6, sp.count);
        for (const [a] of attrs) { ext.vertexAttribDivisorANGLE(a, 0); gl.disableVertexAttribArray(a); }
      } else {
        const d = sp.data;
        for (let k = 0; k < sp.count; k++) {
          const o = k * SPRITE_FLOATS;
          gl.vertexAttrib3f(attrs[0][0], d[o], d[o + 1], d[o + 2]);
          gl.vertexAttrib2f(attrs[1][0], d[o + 3], d[o + 4]);
          gl.vertexAttrib4f(attrs[2][0], d[o + 5], d[o + 6], d[o + 7], d[o + 8]);
          gl.vertexAttrib3f(attrs[3][0], d[o + 9], d[o + 10], d[o + 11]);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
      }
      gl.disableVertexAttribArray(Sx.a.aCorner);
      gl.disable(gl.DEPTH_TEST);
    }
  }
}

// 兵士のスプライト（カメラの方を向いた板）。12 floats/個: 位置3・幅高さ2・UV4・県の色3
const SPRITE_VS = `
attribute vec2 aCorner;
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec4 iUV;
attribute vec3 iTeam;
uniform mat4 uVP;
uniform vec3 uRight;
uniform vec3 uUp;
uniform float uFoot;     // コマの下の余白（足元をそろえる）
varying vec2 vUV;
varying vec3 vTeam;
void main(){
  vec3 p = iPos + uRight * (aCorner.x * iSize.x) + uUp * ((aCorner.y - uFoot) * iSize.y);
  vUV = vec2(mix(iUV.x, iUV.z, aCorner.x + 0.5), mix(iUV.w, iUV.y, aCorner.y));
  vTeam = iTeam;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const SPRITE_FS = `
precision mediump float;
uniform sampler2D uColor;
uniform sampler2D uMask;
varying vec2 vUV;
varying vec3 vTeam;
void main(){
  vec4 c = texture2D(uColor, vUV);
  if (c.a < 0.45) discard;
  float m = texture2D(uMask, vUV).r;
  vec3 col = mix(c.rgb, c.rgb * vTeam * 1.2, m);
  col = col / max(c.a, 0.001) * min(1.0, c.a * 1.6);
  col = pow(col, vec3(1.12)) * 1.04;   // 少しだけ締まった色に（白っぽく浮かないよう）
  gl_FragColor = vec4(col, 1.0);
}`;
const SPRITE_FLOATS = 12;
class SpriteList {
  constructor() { this.data = new Float32Array(SPRITE_FLOATS * 1024); this.count = 0; }
  clear() { this.count = 0; }
  push(x, y, z, w, h, u0, v0, u1, v1, c) {
    if ((this.count + 1) * SPRITE_FLOATS > this.data.length) { const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d; }
    const o = this.count * SPRITE_FLOATS, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w; d[o + 4] = h;
    d[o + 5] = u0; d[o + 6] = v0; d[o + 7] = u1; d[o + 8] = v1; d[o + 9] = c[0]; d[o + 10] = c[1]; d[o + 11] = c[2];
    this.count++;
  }
}

/** インスタンスを貯めるバッファ（メッシュごと） */
class InstanceList {
  constructor() { this.data = new Float32Array(INST_FLOATS * 1024); this.count = 0; }
  clear() { this.count = 0; }
  /** k：色の明るさの倍率（建物ごとのむら） */
  push(x, y, z, sx, sy, sz, c, rot, tilt, k = 1) {
    if ((this.count + 1) * INST_FLOATS > this.data.length) {
      const d = new Float32Array(this.data.length * 2); d.set(this.data); this.data = d;
    }
    const o = this.count * INST_FLOATS, d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = sx; d[o + 4] = sy; d[o + 5] = sz;
    d[o + 6] = c[0] * k; d[o + 7] = c[1] * k; d[o + 8] = c[2] * k; d[o + 9] = rot || 0; d[o + 10] = tilt || 0;
    this.count++;
  }
}
