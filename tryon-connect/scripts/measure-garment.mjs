// Script TEMPORAIRE : mesure un PNG de vêtement (alpha, boîte englobante, profil).
import fs from "node:fs";
import { PNG } from "pngjs";

const file = process.argv[2] ?? "public/garments/mon-pull.png";
const png = PNG.sync.read(fs.readFileSync(file));
const { width: W, height: H, data } = png;
const A = (x, y) => data[(y * W + x) * 4 + 3];
const rgb = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };

let transparent = 0, opaque = 0;
let minX = W, minY = H, maxX = -1, maxY = -1;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const a = A(x, y);
  if (a === 0) transparent++;
  if (a > 20) { opaque++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
}
console.log(`image ${W}x${H}`);
console.log(`transparent(a=0): ${(100 * transparent / (W * H)).toFixed(1)}%  opaque(a>20): ${(100 * opaque / (W * H)).toFixed(1)}%`);
console.log(`corners alpha: ${A(0, 0)} ${A(W - 1, 0)} ${A(0, H - 1)} ${A(W - 1, H - 1)}`);
console.log(`bbox: x ${minX}..${maxX}  y ${minY}..${maxY}  (${maxX - minX + 1}x${maxY - minY + 1})`);

// Couleur moyenne des pixels opaques (pour repérer un fond blanc / damier)
let light = 0;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (A(x, y) > 20) { const [r, g, b] = rgb(x, y); if (r > 200 && g > 200 && b > 200) light++; }
console.log(`opaque pixels very light (>200): ${(100 * light / opaque).toFixed(1)}%`);

// Profil ligne par ligne : segments opaques
for (let y = minY; y <= maxY; y += 5) {
  const segs = []; let s = -1;
  for (let x = 0; x <= W; x++) {
    const o = x < W && A(x, y) > 20;
    if (o && s < 0) s = x;
    if (!o && s >= 0) { segs.push(`${s}-${x - 1}`); s = -1; }
  }
  console.log(`y=${String(y).padStart(3)} ${segs.join(" ")}`);
}
