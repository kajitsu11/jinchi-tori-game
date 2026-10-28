"""日本地図のマップデータを作る。

元データ:
  - 国土地理院「地球地図日本」行政界（jpn-atlas パッケージの build/polbnda_jpn.shp / .dbf）
  - 市区町村名: tools/muni-names.mjs で作った「市区町村コード5桁 → 名前」の JSON

使い方:
  python3 tools/build-japan.py <polbnda_jpn があるフォルダ> <muni-names.json> public/shared/japan.js

出力（japan.js）: window.JAPAN = { W, H, cellKm, muni（gzip+base64 の Uint16 配列。65535＝海）,
  munis: [[名前, 都道府県番号]], prefs: [{name, abbr, pop, color}], links: [a, b, ...], fuji, inset }
"""
import base64, colorsys, gzip, json, math, struct, sys
from collections import deque

PREFS = ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県', '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県',
         '東京都', '神奈川県', '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県', '静岡県', '愛知県', '三重県',
         '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県', '徳島県',
         '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県']
POP_2020_MAN = [522, 124, 121, 230, 96, 107, 183, 287, 193, 194, 734, 628, 1405, 924, 220, 103, 113, 77, 81, 205, 198, 363, 754, 177,
                141, 258, 884, 547, 132, 92, 55, 67, 189, 280, 134, 72, 95, 133, 69, 514, 81, 131, 174, 112, 107, 159, 147]
CELL_KM = 2.0
LAT0 = 36.0                      # 経度方向の縮みはこの緯度で計算する
FUJI = (138.7274, 35.3606)
# 沖縄・奄美は日本海側の枠に移す（地図をコンパクトにするため）。小笠原などの遠い島は入れない
INSET_SHIFT = (6.4, 15.6)


def read_dbf(path):
    data = open(path, 'rb').read()
    n = struct.unpack('<I', data[4:8])[0]
    hlen, rlen = struct.unpack('<HH', data[8:12])
    fields, off = [], 32
    while data[off] != 0x0D:
        fields.append((data[off:off + 11].split(b'\0')[0].decode(), data[off + 16]))
        off += 32
    recs = []
    for i in range(n):
        r, p, rec = data[hlen + i * rlen + 1: hlen + (i + 1) * rlen], 0, {}
        for name, ln in fields:
            rec[name] = r[p:p + ln].decode('utf-8', 'replace').strip()
            p += ln
        recs.append(rec)
    return recs


def read_shp(path):
    data, off, shapes = open(path, 'rb').read(), 100, []
    while off < len(data):
        _, clen = struct.unpack('>II', data[off:off + 8])
        off += 8
        c = data[off:off + clen * 2]
        off += clen * 2
        if struct.unpack('<i', c[:4])[0] == 0:
            shapes.append([])
            continue
        nparts, npts = struct.unpack('<ii', c[36:44])
        parts = list(struct.unpack('<%di' % nparts, c[44:44 + 4 * nparts])) + [npts]
        pts = struct.unpack('<%dd' % (2 * npts), c[44 + 4 * nparts:44 + 4 * nparts + 16 * npts])
        shapes.append([[(pts[2 * k], pts[2 * k + 1]) for k in range(parts[j], parts[j + 1])] for j in range(nparts)])
    return shapes


def transform(lon, lat):
    if lat < 29.0:
        if lon >= 132.0:
            return None                      # 小笠原・南鳥島など
        return lon + INSET_SHIFT[0], lat + INSET_SHIFT[1]
    return lon, lat


def main(shp_dir, names_path, out_path):
    recs = read_dbf(shp_dir + '/polbnda_jpn.dbf')
    shapes = read_shp(shp_dir + '/polbnda_jpn.shp')
    names = json.load(open(names_path, encoding='utf-8'))
    # 2014年以降に市になった・コードが変わった市区町村（地球地図のコード → 名前）
    names.update({'03305': '滝沢市', '04423': '富谷市', '05024': '東成瀬村', '06024': '東成瀬村', '11445': '白岡市',
                  '12402': '大網白里市', '17344': '野々市市', '23304': '長久手市', '32588': '隠岐の島町',
                  '40305': '那珂川市', '43201': '熊本市'})

    # 座標を変換
    polys = []          # (市区町村コード, rings)
    for rec, rings in zip(recs, shapes):
        code = rec['adm_code'][:5]
        if not code.isdigit() or not 1 <= int(code[:2]) <= 47:
            continue
        out = []
        for ring in rings:
            t = [transform(x, y) for x, y in ring]
            if all(p is not None for p in t):
                out.append(t)
        if out:
            polys.append((code, out, rec))

    lons = [x for _, rs, _ in polys for r in rs for x, _ in r]
    lats = [y for _, rs, _ in polys for r in rs for _, y in r]
    kx = math.cos(math.radians(LAT0)) * 111.32 / CELL_KM     # 経度1度あたりのマス数
    ky = 111.0 / CELL_KM                                     # 緯度1度あたりのマス数
    lon0, lat1 = min(lons) - 0.1, max(lats) + 0.1
    W = int((max(lons) + 0.1 - lon0) * kx) + 1
    H = int((lat1 - min(lats) + 0.1) * ky) + 1
    print('grid', W, H, W * H, file=sys.stderr)

    # 市区町村の番号
    codes = sorted({c for c, _, _ in polys})
    idx = {c: k for k, c in enumerate(codes)}
    missing = [c for c in codes if c not in names]
    romaji = {c: r['laa'] for c, _, r in polys}
    munis = [[names.get(c) or romaji[c], int(c[:2]) - 1] for c in codes]
    print('municipalities', len(codes), 'names missing', len(missing), missing[:10], file=sys.stderr)

    # 各ポリゴンを塗る（マスの中心が中にあるか。行ごとに辺との交点を数える）
    grid = [65535] * (W * H)
    for code, rings, _ in polys:
        m = idx[code]
        rows = {}
        for ring in rings:
            pts = [((x - lon0) * kx, (lat1 - y) * ky) for x, y in ring]
            for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]):
                if y0 == y1:
                    continue
                lo, hi = (y0, y1) if y0 < y1 else (y1, y0)
                for row in range(max(0, math.ceil(lo - 0.5)), min(H - 1, math.floor(hi - 0.5)) + 1):
                    yc = row + 0.5
                    if lo <= yc < hi:
                        rows.setdefault(row, []).append(x0 + (yc - y0) * (x1 - x0) / (y1 - y0))
        for row, xs in rows.items():
            xs.sort()
            for a, b in zip(xs[0::2], xs[1::2]):
                for col in range(max(0, math.ceil(a - 0.5)), min(W - 1, math.floor(b - 0.5)) + 1):
                    grid[row * W + col] = m

    land = [g != 65535 for g in grid]

    # 4方向でつながった陸のかたまり
    def components():
        comp = [-1] * (W * H)
        sizes = []
        for s in range(W * H):
            if not land[s] or comp[s] >= 0:
                continue
            cid, q = len(sizes), deque([s])
            comp[s] = cid
            n = 0
            while q:
                i = q.popleft()
                n += 1
                x, y = i % W, i // W
                for j in ((i - 1) if x > 0 else -1, (i + 1) if x < W - 1 else -1, (i - W) if y > 0 else -1, (i + W) if y < H - 1 else -1):
                    if j >= 0 and land[j] and comp[j] < 0:
                        comp[j] = cid
                        q.append(j)
            sizes.append(n)
        return comp, sizes

    # 2マス以下の小さな島は消す（タップしにくく、ゲームに影響しないため）
    comp, sizes = components()
    for i in range(W * H):
        if land[i] and sizes[comp[i]] <= 2:
            land[i] = False
            grid[i] = 65535
    comp, sizes = components()
    print('islands', len(sizes), file=sys.stderr)

    # 島どうしをつなぐ航路：近い島から順に、いちばん近い別の陸へ1本ずつ結んで、全部を1つにつなげる
    parent = list(range(len(sizes)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    links = []
    # 狭い海峡（6マス以内）は、まっすぐ横・縦に何本か結ぶ
    for i in range(W * H):
        if not land[i]:
            continue
        x, y = i % W, i // W
        for dx, dy in ((1, 0), (0, 1)):
            for g in range(2, 7):
                xx, yy = x + dx * g, y + dy * g
                if xx >= W or yy >= H:
                    break
                j = yy * W + xx
                if land[(y + dy) * W + (x + dx)]:
                    break
                if land[j]:
                    if comp[j] != comp[i] and (x + y) % 3 == 0:
                        links.append((i, j))
                        parent[find(comp[i])] = find(comp[j])
                    break
    while True:
        roots = {find(c) for c in range(len(sizes))}
        if len(roots) <= 1:
            break
        # いちばん小さいグループから、海を通って最寄りの別グループを探す
        group = {}
        for c in range(len(sizes)):
            group.setdefault(find(c), []).append(c)
        g = min(group.values(), key=lambda cs: sum(sizes[c] for c in cs))
        gs = set(g)
        start = [i for i in range(W * H) if land[i] and comp[i] in gs]
        prev = {i: -1 for i in start}
        q = deque(start)
        hit = None
        while q and hit is None:
            i = q.popleft()
            x, y = i % W, i // W
            for j in ((i - 1) if x > 0 else -1, (i + 1) if x < W - 1 else -1, (i - W) if y > 0 else -1, (i + W) if y < H - 1 else -1):
                if j < 0 or j in prev:
                    continue
                prev[j] = i
                if land[j] and comp[j] not in gs:
                    hit = j
                    break
                if not land[j]:
                    q.append(j)
        a = hit
        while prev[a] != -1:
            a = prev[a]
        links.append((a, hit))
        parent[find(comp[a])] = find(comp[hit])
    print('links', len(links), file=sys.stderr)

    # 都道府県の人口（2020年国勢調査、万人単位の概数）と色。
    # 地球地図の人口欄は不明値（負の数）や重複があるため使わない
    pops = [v * 10000 for v in POP_2020_MAN]
    cells = [0] * 47
    for g in grid:
        if g != 65535:
            cells[munis[g][1]] += 1
    prefs = []
    for k, name in enumerate(PREFS):
        h = (k * 0.618034) % 1.0                    # となりの番号どうしが似た色にならないように
        r, g, b = colorsys.hls_to_rgb(h, 0.74, 0.62)
        prefs.append({'name': name, 'abbr': name[:2], 'pop': pops[k], 'cells': cells[k],
                      'color': '#%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))})
    print('cells per pref (min)', min(cells), PREFS[cells.index(min(cells))], 'land', sum(cells), file=sys.stderr)

    fx, fy = int((FUJI[0] - lon0) * kx), int((lat1 - FUJI[1]) * ky)
    ilon0, ilat0 = 122.9 + INSET_SHIFT[0], 24.0 + INSET_SHIFT[1]
    ilon1, ilat1 = 131.4 + INSET_SHIFT[0], 29.0 + INSET_SHIFT[1]
    inset = [int((ilon0 - lon0) * kx), int((lat1 - ilat1) * ky), int((ilon1 - ilon0) * kx), int((ilat1 - ilat0) * ky)]

    raw = struct.pack('<%dH' % len(grid), *grid)
    data = {
        'W': W, 'H': H, 'cellKm': CELL_KM,
        'muni': base64.b64encode(gzip.compress(raw, 9)).decode(),
        'munis': munis, 'prefs': prefs, 'links': [v for pair in links for v in pair],
        'fuji': fy * W + fx, 'inset': inset,
        'credit': '地図：国土地理院「地球地図日本」を加工して作成',
    }
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write('// 自動生成：tools/build-japan.py（元データ：国土地理院「地球地図日本」）\n')
        f.write('window.JAPAN = ' + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n')
    print('wrote', out_path, len(data['muni']), 'base64 chars', file=sys.stderr)


if __name__ == '__main__':
    main(*sys.argv[1:4])
