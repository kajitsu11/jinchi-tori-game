// =====================================================================
// アイコン：絵で分かるように。
//   ・建物：ゲームの中の3Dモデルを起動後に1つずつ撮影して画像にする（App.renderIconStep）
//   ・資源・ボタン・知らせ：手描きの絵（SVG。輪郭線・明るい面・影の面の3段で塗る）
// =====================================================================
const ICON = {};   // 建物の3D撮影の画像（dataURL）。撮影が済むまでは下の絵を使う

const O = 'stroke="#2a1a0c" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"';
const SVG_ICON = {
  // ---- 資源
  food: `<ellipse cx="16" cy="22" rx="11" ry="5" fill="#000" opacity=".2"/>
    <path d="M5 15c0-5 5-8 11-8s11 3 11 8v4c0 5-5 7-11 7S5 24 5 19z" fill="#e7c77a" ${O}/>
    <path d="M18 7c5 1 9 4 9 8v4c0 5-5 7-11 7 4-2 6-5 6-9v-4c0-3-1-5-4-6z" fill="#c79a45"/>
    <path d="M5 13h22M5 20h22" stroke="#7a5420" stroke-width="2"/><path d="M11 8v18M21 8v18" stroke="#7a5420" stroke-width="1.4" opacity=".7"/>
    <path d="M9 10c2-1 4-1.5 6-1.5" stroke="#fff5d0" stroke-width="1.6" stroke-linecap="round"/>`,
  wood: `<ellipse cx="16" cy="25" rx="12" ry="4" fill="#000" opacity=".2"/>
    <rect x="4" y="16" width="22" height="7" rx="3.5" fill="#a8743e" ${O}/><circle cx="25" cy="19.5" r="3.6" fill="#e3bd82" ${O}/><circle cx="25" cy="19.5" r="1.4" fill="none" stroke="#a8743e" stroke-width="1"/>
    <rect x="7" y="9" width="20" height="7" rx="3.5" fill="#bb8549" ${O}/><circle cx="26" cy="12.5" r="3.6" fill="#ecc890" ${O}/><circle cx="26" cy="12.5" r="1.4" fill="none" stroke="#a8743e" stroke-width="1"/>
    <path d="M9 11h12M7 18h13" stroke="#7a4e22" stroke-width="1.2" opacity=".7"/>`,
  gold: `<ellipse cx="16" cy="26" rx="10" ry="3" fill="#000" opacity=".2"/>
    <ellipse cx="16" cy="15" rx="9" ry="12" fill="#f0c94a" ${O}/><ellipse cx="16" cy="15" rx="6.6" ry="9.4" fill="none" stroke="#b58a1c" stroke-width="1.2"/>
    <path d="M11 9h10M10.5 13h11M10.5 17h11M11 21h10" stroke="#c99a26" stroke-width="1.2"/>
    <path d="M10 8c1.5-2.5 3.5-3.5 6-3.5" stroke="#fff6c0" stroke-width="1.8" stroke-linecap="round"/>`,
  units: `<ellipse cx="16" cy="27" rx="10" ry="3" fill="#000" opacity=".2"/>
    <path d="M4 18c0-7 5-12 12-12s12 5 12 12z" fill="#3a3a44" ${O}/><path d="M16 6c7 0 12 5 12 12h-6c0-6-2-10-6-12z" fill="#24242c"/>
    <path d="M2 18h28l-3 5H5z" fill="#4b4b56" ${O}/><path d="M9 11c1-2 3-3 5-3.5" stroke="#9a9aae" stroke-width="1.6" stroke-linecap="round"/>
    <path d="M16 6l-5-4m5 4l5-4" stroke="#e0b445" stroke-width="2.4" stroke-linecap="round"/><circle cx="16" cy="13" r="2.4" fill="#e0b445" ${O}/>`,
  // ---- 右の操作
  rank: `<path d="M8 6h16v5c0 6-4 9-8 9s-8-3-8-9z" fill="#f0c94a" ${O}/><path d="M16 20c4 0 8-3 8-9V6h-4v5c0 5-2 8-4 9z" fill="#c99a26"/>
    <path d="M8 8H4c0 4 2 6 5 6M24 8h4c0 4-2 6-5 6" fill="none" ${O}/><rect x="13" y="20" width="6" height="4" fill="#c99a26" ${O}/><rect x="9" y="24" width="14" height="4" rx="1" fill="#7a4e22" ${O}/>
    <path d="M11 8v3" stroke="#fff6c0" stroke-width="1.8" stroke-linecap="round"/>`,
  top: `<path d="M5 8l7-3 8 3 7-3v19l-7 3-8-3-7 3z" fill="#e9dcb4" ${O}/><path d="M12 5v19M20 8v19" stroke="#2a1a0c" stroke-width="1.2"/>
    <path d="M7 14c3-2 5 1 8-1s5 2 9 0" fill="none" stroke="#4f8a3a" stroke-width="2"/><circle cx="21" cy="18" r="2" fill="#c8392b"/>`,
  home: `<path d="M3 27h26" ${O}/><path d="M6 27l2-7h16l2 7z" fill="#8f8a80" ${O}/><rect x="10" y="14" width="12" height="6" fill="#f2ecdc" ${O}/>
    <path d="M7 15l9-6 9 6z" fill="#3b4048" ${O}/><rect x="12.5" y="7" width="7" height="4" fill="#f2ecdc" ${O}/><path d="M10 8l6-4 6 4z" fill="#3b4048" ${O}/>
    <rect x="14.5" y="16" width="3" height="4" fill="#2a1a0c"/>`,
  squad: `<path d="M16 29s-9-9-9-16a9 9 0 0118 0c0 7-9 16-9 16z" fill="#c8392b" ${O}/><path d="M16 4a9 9 0 019 9c0 7-9 16-9 16 3-6 5-11 5-16 0-4-2-7-5-9z" fill="#962419"/>
    <circle cx="16" cy="13" r="3.5" fill="#fff3e0" ${O}/>`,
  sound: `<ellipse cx="16" cy="9" rx="10" ry="4" fill="#e9dcb4" ${O}/><path d="M6 9v12c0 2 4.5 4 10 4s10-2 10-4V9c0 2-4.5 4-10 4S6 11 6 9z" fill="#a8432e" ${O}/>
    <path d="M18 13c5-.5 8-2 8-4v12c0 2-3 3.5-8 4z" fill="#7d2c1c"/><path d="M8 13v8M24 13v8" stroke="#e0b445" stroke-width="1.4"/><circle cx="16" cy="19" r="1.4" fill="#e0b445"/>`,
  title: `<path d="M3 8c5 1 21 1 26 0" fill="none" stroke="#c8392b" stroke-width="3.2" stroke-linecap="round"/><path d="M3 8c5 1 21 1 26 0" fill="none" stroke="#2a1a0c" stroke-width=".9"/>
    <path d="M6 13h20" stroke="#c8392b" stroke-width="2.6"/><path d="M9 9v19M23 9v19" stroke="#c8392b" stroke-width="3"/><path d="M9 9v19M23 9v19" stroke="#2a1a0c" stroke-width=".8" opacity=".6"/>`,
  // ---- 指示・作戦
  attack: `<path d="M5 26L22 6l3-1-1 3L7 28z" fill="#dfe4ea" ${O}/><path d="M7 28l-3 1 1-3 2-1z" fill="#2a1a0c"/><path d="M8 22l3 3" stroke="#7a4e22" stroke-width="3"/>
    <path d="M27 26L10 6 7 5l1 3 17 20z" fill="#cfd5db" ${O}/><path d="M24 22l-3 3" stroke="#7a4e22" stroke-width="3"/>`,
  flag: `<path d="M9 3v26" stroke="#5a3a1c" stroke-width="2.4" stroke-linecap="round"/><path d="M10 5h15v14H10z" fill="#e2e2e2" ${O}/>
    <path d="M18 5h7v14h-7z" fill="#bdbdbd"/><circle cx="17.5" cy="12" r="3.4" fill="#c8392b" ${O}/>`,
  general: `<path d="M5 20c0-8 5-13 11-13s11 5 11 13z" fill="#2f2f38" ${O}/><path d="M2 20h28l-4 5H6z" fill="#3e3e48" ${O}/>
    <path d="M16 8C12 4 8 2 5 2c3 2 6 5 8 9M16 8c4-4 8-6 11-6-3 2-6 5-8 9" fill="#f0c94a" ${O}/><circle cx="16" cy="13" r="2.6" fill="#c8392b" ${O}/>`,
  barrage: `<ellipse cx="16" cy="27" rx="9" ry="2.5" fill="#000" opacity=".2"/><circle cx="15" cy="18" r="9" fill="#34343c" ${O}/><path d="M15 9a9 9 0 019 9 9 9 0 01-9 9c4-3 5-6 5-9s-1-6-5-9z" fill="#1f1f25"/>
    <path d="M10 13c1-2 3-3 5-3" stroke="#8a8a98" stroke-width="2" stroke-linecap="round"/><path d="M20 10c2-3 4-4 6-4" fill="none" stroke="#7a4e22" stroke-width="2"/>
    <path d="M26 2l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="#ffcf3f" ${O}/>`,
  reinforce: `<path d="M16 3l11 4v8c0 7-5 12-11 14C10 27 5 22 5 15V7z" fill="#3e6aa8" ${O}/><path d="M16 3l11 4v8c0 7-5 12-11 14z" fill="#2c4f80"/>
    <path d="M16 9v12M10 15h12" stroke="#fff3e0" stroke-width="3" stroke-linecap="round"/>`,
  rally: `<path d="M4 20c3-8 10-13 19-13l4 2-2 4c-9 1-14 4-18 10z" fill="#f2e2c4" ${O}/><path d="M23 7l4 2-2 4c-2-.5-3-2-2-6z" fill="#d6b98a"/>
    <path d="M9 17c2-3 6-6 11-7M11 20c2-2 5-4 9-5" stroke="#b08a5a" stroke-width="1.2" fill="none"/><path d="M4 20l-1 6 6-2" fill="#c8a06a" ${O}/>
    <path d="M27 3v3M29 9h-2M28 5l-1.5 1.5" stroke="#ffcf3f" stroke-width="1.8" stroke-linecap="round"/>`,
  // ---- 知らせ（記録の先頭）
  warn: `<path d="M16 3l14 25H2z" fill="#f0c94a" ${O}/><path d="M16 3l14 25h-7z" fill="#c99a26"/><path d="M16 11v8" stroke="#2a1a0c" stroke-width="3" stroke-linecap="round"/><circle cx="16" cy="23.5" r="1.8" fill="#2a1a0c"/>`,
  war: `<path d="M6 26L22 6m-2 0h3v3M26 26L10 6m2 0H9v3" fill="none" stroke="#2a1a0c" stroke-width="4" stroke-linecap="round"/><path d="M6 26L22 6M26 26L10 6" stroke="#dfe4ea" stroke-width="2" stroke-linecap="round"/><circle cx="16" cy="16" r="3" fill="#c8392b" ${O}/>`,
  build: `<path d="M5 27h22" ${O}/><path d="M8 27V15l8-6 8 6v12z" fill="#c9a676" ${O}/><path d="M16 9l8 6v12h-8z" fill="#a8854f"/><path d="M5 16l11-9 11 9" fill="none" stroke="#3b4048" stroke-width="3" stroke-linecap="round"/><rect x="13.5" y="19" width="5" height="8" fill="#5a3a1c"/>`,
  news: `<rect x="6" y="4" width="20" height="24" rx="2" fill="#f2e6c4" ${O}/><path d="M10 10h12M10 15h12M10 20h8" stroke="#7a5a30" stroke-width="1.6" stroke-linecap="round"/><circle cx="22" cy="23" r="3" fill="#c8392b"/>`,
  rain: `<path d="M9 16a5 5 0 010-10 7 7 0 0113 1 4.5 4.5 0 011 9z" fill="#d9e2ea" ${O}/><path d="M10 20l-2 5M16 20l-2 5M22 20l-2 5" stroke="#4a7ab0" stroke-width="2" stroke-linecap="round"/>`,
  fire: `<path d="M16 3c2 5 9 8 9 16a9 9 0 01-18 0c0-5 3-7 4-10 1 3 2 4 3 4 0-4 0-7 2-10z" fill="#e8601c" ${O}/><path d="M16 15c1 3 4 4 4 8a4 4 0 01-8 0c0-2 1-3 2-5 .5 1 1 1.5 2 1.5z" fill="#ffd060"/>`,
  plague: `<circle cx="16" cy="16" r="7" fill="#8fbf4a" ${O}/><path d="M16 4v5M16 23v5M4 16h5M23 16h5M7.5 7.5l3.5 3.5M21 21l3.5 3.5M24.5 7.5L21 11M11 21l-3.5 3.5" stroke="#2a1a0c" stroke-width="2" stroke-linecap="round"/><circle cx="14" cy="14" r="1.6" fill="#5a8a2a"/><circle cx="18.5" cy="18" r="1.3" fill="#5a8a2a"/>`,
  target: `<circle cx="16" cy="16" r="12" fill="#f2e6c4" ${O}/><circle cx="16" cy="16" r="8" fill="#c8392b" ${O}/><circle cx="16" cy="16" r="4" fill="#f2e6c4" ${O}/><circle cx="16" cy="16" r="1.5" fill="#c8392b"/>`,
  final: `<path d="M16 3c2 5 9 8 9 16a9 9 0 01-18 0c0-5 3-7 4-10 1 3 2 4 3 4 0-4 0-7 2-10z" fill="#c8392b" ${O}/><path d="M16 15c1 3 4 4 4 8a4 4 0 01-8 0c0-2 1-3 2-5 .5 1 1 1.5 2 1.5z" fill="#ffcf3f"/>`,
};
/** アイコンのHTML。k：建物の種類・資源・ボタンの名前。建物は撮影済みなら3Dの画像、まだなら絵 */
function icon(k, cls = '') {
  if (ICON[k]) return `<img class="ico pic ${cls}" src="${ICON[k]}" alt="" draggable="false">`;
  const svg = SVG_ICON[k];
  if (svg) return `<i class="ico ${cls}"><svg viewBox="0 0 32 32" aria-hidden="true">${svg}</svg></i>`;
  return `<i class="ico ${cls}"><svg viewBox="0 0 32 32" aria-hidden="true">${SVG_ICON.build}</svg></i>`;
}
