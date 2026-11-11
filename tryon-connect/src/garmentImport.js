// Import d'un vêtement depuis une image : tout se passe dans le navigateur.
//
// Étapes :
//  1. normalizeFile   : décode le fichier, le réduit à 1000 px de large max, PNG.
//  2. processGarment  : - garde la transparence si l'image en a déjà une,
//                       - sinon supprime le fond (couleur estimée sur les bords,
//                         remplissage DEPUIS LES BORDS avec tolérance),
//                       - adoucit le contour, recadre avec une petite marge,
//                       - calcule les ancres automatiquement,
//                       - signale un détourage qui semble raté.
// Les fonctions "pures" (sur des tableaux de pixels) sont exportées pour pouvoir
// être testées hors navigateur.

export const DEFAULT_TOLERANCE = 30; // 0..100
const MAX_WIDTH = 1000;
const ALPHA_OPAQUE = 128;

// ---------- Outils canvas ----------

function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encodage PNG impossible"))), "image/png")
  );
}

async function decode(blob) {
  if (typeof createImageBitmap === "function") return createImageBitmap(blob);
  // Repli : via un élément <img>
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Image illisible"));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

// 1. Fichier choisi → PNG réduit (c'est "l'original" qu'on garde pour recalculer)
export async function normalizeFile(file) {
  const bmp = await decode(file);
  const w0 = bmp.width, h0 = bmp.height;
  const scale = Math.min(1, MAX_WIDTH / w0);
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return canvasToBlob(c);
}

// ---------- Fonctions pures (pixels RGBA) ----------

// Vraie transparence : au moins 1 % de pixels nettement transparents
export function hasTransparency(data) {
  let n = 0;
  const total = data.length / 4;
  for (let j = 3; j < data.length; j += 4) if (data[j] < ALPHA_OPAQUE) n++;
  return n > total * 0.01;
}

// Couleur(s) du fond, estimées sur le pourtour de l'image.
// On garde jusqu'à 3 couleurs fréquentes (utile pour un damier ou un fond dégradé).
export function estimateBorderColors(data, w, h) {
  const bins = new Map();
  const addPx = (x, y) => {
    const j = (y * w + x) * 4;
    const key = ((data[j] >> 4) << 8) | ((data[j + 1] >> 4) << 4) | (data[j + 2] >> 4);
    let b = bins.get(key);
    if (!b) { b = { n: 0, r: 0, g: 0, b: 0 }; bins.set(key, b); }
    b.n++; b.r += data[j]; b.g += data[j + 1]; b.b += data[j + 2];
  };
  for (let x = 0; x < w; x++) { addPx(x, 0); addPx(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { addPx(0, y); addPx(w - 1, y); }

  const total = 2 * w + 2 * (h - 2);
  const sorted = [...bins.values()].sort((a, b) => b.n - a.n);
  const keep = sorted.filter((b) => b.n >= total * 0.1).slice(0, 3);
  if (!keep.length) keep.push(sorted[0]);
  return keep.map((b) => ({ r: b.r / b.n, g: b.g / b.n, b: b.b / b.n }));
}

// Supprime le fond EN PLACE (canal alpha). Renvoie le nombre de pixels de fond.
// tolerance : 0..100 → distance de couleur acceptée par rapport au fond.
export function removeBackground(data, w, h, tolerance) {
  const colors = estimateBorderColors(data, w, h);
  const thr = Math.max(1, tolerance * 2.2);
  const thr2 = thr * thr;
  const N = w * h;

  // Distance² minimale aux couleurs du fond
  const dist2 = (i) => {
    const j = i * 4;
    let best = Infinity;
    for (const c of colors) {
      const dr = data[j] - c.r, dg = data[j + 1] - c.g, db = data[j + 2] - c.b;
      const d = dr * dr + dg * dg + db * db;
      if (d < best) best = d;
    }
    return best;
  };

  // Remplissage depuis les bords : seules les zones de fond RELIÉES au bord
  // sont supprimées (un trou à l'intérieur du vêtement reste intact).
  const bg = new Uint8Array(N);
  const queue = new Int32Array(N);
  let head = 0, tail = 0;
  const tryPush = (i) => {
    if (bg[i]) return;
    if (dist2(i) > thr2) return;
    bg[i] = 1;
    queue[tail++] = i;
  };
  for (let x = 0; x < w; x++) { tryPush(x); tryPush((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { tryPush(y * w); tryPush(y * w + w - 1); }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) tryPush(i - 1);
    if (x < w - 1) tryPush(i + 1);
    if (i >= w) tryPush(i - w);
    if (i < N - w) tryPush(i + w);
  }

  // Alpha : fond = 0 ; au bord du vêtement, transparence progressive selon la
  // ressemblance avec le fond (contour adouci)
  const alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (bg[i]) continue;
    const x = i % w;
    const touchesBg =
      (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) ||
      (i >= w && bg[i - w]) || (i < N - w && bg[i + w]);
    if (touchesBg) {
      const k = (Math.sqrt(dist2(i)) - thr) / (thr * 0.6 + 1);
      alpha[i] = Math.round(255 * Math.min(1, Math.max(0.3, k)));
    } else {
      alpha[i] = 255;
    }
  }

  // Petit flou 3×3 vers l'intérieur seulement (min avec la moyenne) : pas de halo
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!alpha[i]) continue;
      let s = 0, edge = false;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const a = alpha[i + dy * w + dx];
          s += a;
          if (a < 255) edge = true;
        }
      }
      if (edge) data[i * 4 + 3] = Math.min(alpha[i], Math.round(s / 9));
      else data[i * 4 + 3] = 255;
    }
  }
  // Pourtour de l'image et fond
  for (let i = 0; i < N; i++) {
    const x = i % w, y = (i / w) | 0;
    if (bg[i]) data[i * 4 + 3] = 0;
    else if (x === 0 || y === 0 || x === w - 1 || y === h - 1) data[i * 4 + 3] = alpha[i];
  }

  let count = 0;
  for (let i = 0; i < N; i++) if (bg[i]) count++;
  return count;
}

// Boîte englobante des pixels visibles (alpha > 20)
export function alphaBBox(data, w, h) {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

const median = (arr) => {
  if (!arr.length) return NaN;
  const s = [...arr].sort((a, b) => a - b);
  return s[s.length >> 1];
};

// Ancres automatiques, à partir du profil de largeur ligne par ligne.
//  - "Tronc" d'une ligne = segment opaque qui contient le centre du vêtement
//    (les manches séparées du corps n'en font pas partie).
//  - Largeur de référence du torse = médiane du tronc entre 60 et 85 % de la hauteur.
//  - Ligne des épaules = première ligne (depuis le haut) dont le tronc atteint
//    90 % de cette largeur : le col, plus étroit, est ainsi ignoré.
//  - shoulderLeft / Right = bords du torse sur cette ligne (même y).
//  - hipY = 92 % entre la ligne des épaules et le bas.
//  - armpitY = première ligne où une manche se détache du corps (si elle existe).
export function computeAnchors(data, w, h) {
  const bb = alphaBBox(data, w, h);
  if (!bb) return null;
  const opaque = (x, y) => data[(y * w + x) * 4 + 3] > ALPHA_OPAQUE;
  const cx = Math.round((bb.x0 + bb.x1) / 2);
  const H = bb.y1 - bb.y0 + 1;
  const W = bb.x1 - bb.x0 + 1;

  // Tronc de la ligne y : [left, right] autour du centre (trous de 2 px tolérés)
  const trunk = (y) => {
    let start = -1;
    const reach = Math.round(W * 0.1);
    for (let d = 0; d <= reach; d++) {
      if (cx - d >= 0 && opaque(cx - d, y)) { start = cx - d; break; }
      if (cx + d < w && opaque(cx + d, y)) { start = cx + d; break; }
    }
    if (start < 0) return null;
    let l = start, r = start, gap = 0;
    for (let x = start - 1; x >= 0; x--) {
      if (opaque(x, y)) { l = x; gap = 0; } else if (++gap > 2) break;
    }
    gap = 0;
    for (let x = start + 1; x < w; x++) {
      if (opaque(x, y)) { r = x; gap = 0; } else if (++gap > 2) break;
    }
    return { l, r };
  };
  const extent = (y) => {
    let l = -1, r = -1;
    for (let x = 0; x < w; x++) if (opaque(x, y)) { if (l < 0) l = x; r = x; }
    return l < 0 ? null : { l, r };
  };

  // Largeur de référence du torse (bas du vêtement, hors bande du bas)
  const Ls = [], Rs = [];
  for (let y = Math.round(bb.y0 + 0.6 * H); y <= Math.round(bb.y0 + 0.85 * H); y++) {
    const t = trunk(y);
    if (t) { Ls.push(t.l); Rs.push(t.r); }
  }
  let TL = median(Ls), TR = median(Rs);
  if (!(TR - TL > W * 0.2)) {
    // Profil inexploitable : valeurs prudentes
    TL = bb.x0 + 0.25 * W;
    TR = bb.x0 + 0.75 * W;
  }
  const TW = TR - TL;

  // Ligne des épaules
  let yS = -1;
  const yMax = Math.round(bb.y0 + 0.45 * H);
  for (let y = bb.y0; y <= yMax; y++) {
    const t = trunk(y);
    if (t && t.r - t.l >= 0.9 * TW) { yS = y; break; }
  }
  if (yS < 0) yS = Math.round(bb.y0 + 0.15 * H);

  const hipY = Math.round(yS + 0.92 * (bb.y1 - yS));

  // Aisselles : première ligne où une manche est séparée du tronc
  let armpitY;
  const margin = Math.max(3, Math.round(0.03 * TW));
  for (let y = Math.round(yS + 0.1 * (hipY - yS)); y < hipY; y++) {
    const t = trunk(y), e = extent(y);
    if (t && e && (e.l < t.l - margin || e.r > t.r + margin)) { armpitY = y; break; }
  }

  const anchors = {
    shoulderLeft: { x: Math.round(TL), y: yS },
    shoulderRight: { x: Math.round(TR), y: yS },
    hipY,
  };
  if (armpitY !== undefined) anchors.armpitY = armpitY;
  return anchors;
}

// ---------- Traitement complet ----------

// Ancres d'un canvas déjà détouré (bouton "Recalculer les ancres")
export function computeAnchorsFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return computeAnchors(data, canvas.width, canvas.height);
}

// 2. Original (Blob PNG) → vêtement détouré, recadré, avec ancres.
export async function processGarment(originalBlob, tolerance = DEFAULT_TOLERANCE) {
  const bmp = await decode(originalBlob);
  const w = bmp.width, h = bmp.height;
  const src = makeCanvas(w, h);
  const sctx = src.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  const img = sctx.getImageData(0, 0, w, h);
  const data = img.data;

  const hadAlpha = hasTransparency(data);
  if (!hadAlpha) removeBackground(data, w, h, tolerance);

  // Part de l'image qui reste visible → détection d'un détourage raté
  let visible = 0;
  for (let j = 3; j < data.length; j += 4) if (data[j] > ALPHA_OPAQUE) visible++;
  const ratio = visible / (w * h);
  let warning = null;
  if (ratio < 0.04) warning = "Le détourage a presque tout effacé.";
  else if (ratio > (hadAlpha ? 0.97 : 0.9)) warning = "Le fond semble presque intact.";
  sctx.putImageData(img, 0, 0);

  // Recadrage avec petite marge
  const bb = alphaBBox(data, w, h) ?? { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  const m = Math.max(4, Math.round(0.02 * Math.max(w, h)));
  const x0 = Math.max(0, bb.x0 - m), y0 = Math.max(0, bb.y0 - m);
  const x1 = Math.min(w - 1, bb.x1 + m), y1 = Math.min(h - 1, bb.y1 + m);
  const out = makeCanvas(x1 - x0 + 1, y1 - y0 + 1);
  out.getContext("2d").drawImage(src, x0, y0, out.width, out.height, 0, 0, out.width, out.height);

  const anchors = computeAnchorsFromCanvas(out);
  const blob = await canvasToBlob(out);
  return { canvas: out, blob, anchors, hadAlpha, warning, visibleRatio: ratio };
}

// Conseil affiché quand le détourage semble raté
export const IMPORT_ADVICE =
  "Conseil : utilise un PNG déjà détouré (par exemple avec remove.bg) ou règle la tolérance dans « Ajuster ».";
