# 47都道府県対抗 陣取り合戦

日本地図を約61万マスに区切り、47都道府県で奪い合うスマホ縦画面向けブラウザゲーム（試作版）。
`index.html` 1ファイルだけで動きます（地図データ・WebGL描画・ゲームすべて埋め込み、外部ライブラリなし）。

## 遊び方
`index.html` をブラウザで開く → 自分の県を選んで「この県で出陣」。

- 1日1回、**攻撃**（自県に8方向で隣接する他県のマスを1マス）か **防御**（自県のマスを1マス、その日いっぱい不可侵）。
- 赤く点滅しているマスが攻撃できるマス。タップ →「⚔ 今すぐ攻撃する」。
- 1日は90秒。AIの参加者がばらばらの時刻に行動し、地図が塗り替わっていく。「次の日へ」で日報を出して翌日へ。
- 1マスの持ち主が変わるのは1日1回まで（変わったマスは斜線表示）。
- 全国の陸地の50%で勝利、自県のマスが0で敗北。
- 操作：ドラッグで移動、ピンチ／ホイールで拡大縮小。PCは矢印キー/WASDで移動、`+`/`-`で拡大縮小、`T` 真上ビュー、`H` 自県へ、`Enter` 行動、`Esc` 閉じる。

## ファイル構成
| パス | 内容 |
|---|---|
| `index.html` | 完成品（ビルド生成物） |
| `src/game.js` | ゲーム本体（CONFIG / マップ展開 / カメラ / WebGL描画 / ルール・AI / UI / ステートマシン） |
| `src/style.css`, `src/template.html` | 画面レイアウト |
| `tools/preprocess.py` | 地図データの前処理 → `data/mapdata.json`、確認画像 `data/preview/*.png` |
| `tools/prefdata.py` | 県名・人口・県庁所在地、連絡マス（トンネル・橋・航路）、市街地の種になる都市 |
| `tools/build.py` | `src/` と `data/mapdata.json` を `index.html` に組み立て |
| `tests/run_tests.js` | Playwright 自動テスト |

## ビルド
```sh
pip install numpy pillow scipy
python3 tools/preprocess.py   # data/japan.topojson → data/mapdata.json（標高タイルは data/dem_cache/ にキャッシュ）
python3 tools/build.py        # → index.html
node tests/run_tests.js       # Playwright テスト（DAYS=60 などで長期テストの日数を変更）
```

## 地図データの作り方
- 都道府県境・海岸線：[dataofjapan/land](https://github.com/dataofjapan/land) の `japan.topojson`（出典：地球地図日本（国土地理院））。
- グリッド：経度0.009°×緯度0.0072°、2400×2160マス（東経128.25°〜、北緯45.65°〜）、陸地 612,049マス。
- インセット：本土から離れすぎる島はずらして配置し、枠と説明を表示。
  - 南西諸島（沖縄県＋奄美・トカラ）… 北東へ（経度+6°, 緯度+14°）ずらして日本海側に表示
  - 小笠原・硫黄島（+3.5°, +8°）、南鳥島も小笠原の近くへ
- 地形：AWS Terrain Tiles（z8）の標高・傾斜と主要都市の位置から、平地／森／山／市街地を判定。雪は緯度と日本海側の雪線から判定。
- 圧縮：県IDと地形をそれぞれ RLE（値＋可変長整数）＋ base64。
- 県境・海岸線：topojson のアークを共有数で県境／海岸線に分け、ダグラス・ポイカー法（許容0.45マス）で簡略化したベクター線。
- 連絡マス：青函トンネル、関門、明石海峡大橋、大鳴門橋、瀬戸大橋、しまなみ海道、アクアライン、沖縄航路など18ルート。
  ほかの小島は最寄りの陸地へ自動でつなぎ、全国の陸地がひとつながりになるようにしている。
- 配色：CIELABの色差（ΔE76）で、隣接県（連絡マスでつながる県を含む）の最小色差を最大化するよう焼きなまし法で割り当て。
  現在の結果は **隣接県の最小ΔE = 72.8**、全47色の最小ΔE = 12.6。

## 主な調整値（`src/game.js` の `CONFIG`）
`DAY_SECONDS`（1日の秒数）、`WIN_RATIO`（勝利割合）、`PARTICIPANTS_PER_MILLION`・`MIN_PARTICIPANTS`（参加者数）、
`ATTACK_SUCCESS`（攻撃成功率）、`AI_DEFENDER_RATIO`（AIの防御担当の割合）、`AI_YESTERDAY_WEIGHT`・`AI_CAPITAL_WEIGHT`（AIが前日の場所・県庁を重視する度合い）など。
