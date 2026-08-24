// 解码 render-globe.js 输出的 PNG，统计颜色直方图，校验 NES 配色
const fs = require('fs');
const zlib = require('zlib');

function parsePng(file) {
  const b = fs.readFileSync(file);
  const W = b.readUInt32BE(16), H = b.readUInt32BE(20);
  let off = 8, idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(b.slice(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const img = Buffer.alloc(W * H * 3);
  let p = 0;
  for (let y = 0; y < H; y++) {
    p++; // filter byte
    for (let x = 0; x < W * 3; x++) img[y * W * 3 + x] = raw[p++];
  }
  const colors = new Map();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    const key = img[i].toString(16).padStart(2, '0') + img[i + 1].toString(16).padStart(2, '0') + img[i + 2].toString(16).padStart(2, '0');
    colors.set(key, (colors.get(key) || 0) + 1);
  }
  return { W, H, colors };
}

const targets = {
  '0000a8': '天空带1 NES深蓝', '0000bc': '天空带2/深海', '0058f8': '天空带3/中海',
  '3cbcfc': '天空带4/浅海', '000078': '球体描边', '005800': '深草绿', '00a800': 'NES绿',
  '58f898': '亮草绿', '000000': '陆地黑描边', 'f8b800': '高亮黄', 'fcfcfc': '高亮白/旗杆',
  'f83800': '旗红', '585858': '旗座灰',
};
for (const f of process.argv.slice(2)) {
  const { W, H, colors } = parsePng(f);
  const top = [...colors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log(`=== ${f.split(/[\\/]/).pop()} (${W}x${H}) ===`);
  for (const [c, n] of top) {
    const tag = targets[c] || '';
    console.log(`  #${c}  x${n}  ${tag}`);
  }
  console.log('');
}
