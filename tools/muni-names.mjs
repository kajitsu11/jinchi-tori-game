// 全国地方公共団体コード（@b4moss/jp-local-gov-id-data, MIT）から「市区町村コード5桁 → 名前」を取り出す
// 使い方：node tools/muni-names.mjs <パッケージを展開したフォルダ> > muni-names.json
import { readFileSync, readdirSync } from 'node:fs';
import { brotliDecompressSync } from 'node:zlib';
const dir = process.argv[2] + '/prefectures';
const out = {};
for (const f of readdirSync(dir)) {
  const b = brotliDecompressSync(readFileSync(`${dir}/${f}`));
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (String.fromCharCode(...b.subarray(0, 4)) !== 'JLDT') throw new Error('unknown format ' + f);
  let pos = 5;
  const asOfLen = b[pos++];
  pos += asOfLen;
  const n = v.getUint16(pos, true); pos += 2;
  const strBase = pos + n * 14;
  const str = (off) => { let e = strBase + off; while (b[e]) e++; return new TextDecoder().decode(b.subarray(strBase + off, e)); };
  for (let k = 0; k < n; k++, pos += 14) {
    const code = String(v.getUint32(pos, true)).padStart(6, '0').slice(0, 5);
    out[code] = str(v.getUint32(pos + 4, true));
  }
}
process.stdout.write(JSON.stringify(out));
