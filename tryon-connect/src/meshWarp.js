// Déformation du vêtement selon le torse (« mesh warp »).
//
// Principe :
//  - On pose une grille régulière sur l'image du vêtement (côté vêtement).
//  - Chaque point de la grille est envoyé sur le corps grâce à des
//    "coordonnées de torse" :
//      u = position horizontale (−1 = épaule gauche de l'image, +1 = épaule droite)
//      t = position verticale   (0 = ligne des épaules, 1 = ligne des hanches)
//    Côté corps, pour chaque t on connaît un centre, une direction et une
//    demi-largeur, interpolés entre épaules → taille → hanches.
//  - Chaque case de la grille = 2 triangles. Chaque triangle est dessiné avec
//    sa propre transformation affine, limitée (clip) au triangle.
//  - Les épaules du vêtement sont remontées et écartées par rapport aux points
//    MediaPipe (qui sont sur l'articulation), avec les réglages shoulderLift /
//    shoulderSpread et, si disponible, le contour réel mesuré (shoulderFit.js).
//  - Les manches (|u| > 1) sont élargies près de l'épaule et tournent vers le coude.
import { DEFAULT_FIT } from "./garments.js";

// --- Réglages ---
const GRID_COLS = 10;       // finesse du maillage (plus = plus précis, plus lent)
const GRID_ROWS = 14;
const OVERLAP_PX = 0.8;     // recouvrement des triangles : évite les fines lignes
const ALPHA_MIN = 20;       // pixel considéré "opaque" au-delà

const WAIST_T = 0.6;        // la taille est à 60 % entre épaules et hanches
const WAIST_FIT = 0.98;     // la taille est très légèrement cintrée
// Écart des hanches MediaPipe / écart des épaules, pour une personne de face.
// Sert à calculer un léger évasement ou rétrécissement en bas du vêtement.
const HIP_RATIO_REF = 0.65;
const HIP_TAPER_MIN = 0.85;
const HIP_TAPER_MAX = 1.1;
const NECK_HEIGHT = 0.15;   // base du cou : 15 % de la largeur d'épaules au-dessus

// Épaules : marges ajoutées au contour réel mesuré, et bornes de sécurité
const SHOULDER_TOP_MARGIN = 0.03;   // en fraction de la largeur d'épaules
const SHOULDER_OUT_MARGIN = 1.04;   // le vêtement dépasse de 4 % le bord réel
const LIFT_MAX = 0.35;
const SPREAD_MIN = 0.85;
const SPREAD_MAX = 1.6;

// Manches : on suit le bras, mais modérément (manche courte)
const SLEEVE_ANGLE_DEFAULT = 20;          // angle de la manche dans l'image (degrés depuis la verticale)
const SLEEVE_FOLLOW = 0.8;                // part du mouvement du bras recopiée
const SLEEVE_MIN = (-15 * Math.PI) / 180; // rotation max vers le corps
const SLEEVE_MAX = (40 * Math.PI) / 180;  // rotation max vers l'extérieur
const SLEEVE_EASE = 0.35;                 // la rotation change en douceur (pas de saut)
// Élargissement du haut de la manche (couvre le tour du bras près de l'épaule),
// en fraction de la demi-largeur d'épaules
const SLEEVE_CAP_OUT = 0.16;              // vers l'extérieur
const SLEEVE_CAP_UP = 0.06;               // vers le haut
const SLEEVE_CAP_REACH = 0.9;             // l'effet disparaît à cette distance de l'épaule

// ---------- Petits outils vectoriels ----------
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
const lerp = (a, b, k) => ({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
const dot = (a, b) => a.x * b.x + a.y * b.y;
const len = (a) => Math.hypot(a.x, a.y);
const unit = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, v) => { const k = clamp((v - e0) / (e1 - e0), 0, 1); return k * k * (3 - 2 * k); };

// État conservé d'une image à l'autre
const sleeveRot = [0, 0];   // rotation lissée des manches (côté 11, côté 12)
let lastDebug = null;       // points de contrôle du dernier dessin (debug)

// ---------- Préparation de l'image (une seule fois par vêtement) ----------

const meshCache = new WeakMap();

// Couleur dominante : la case la plus remplie d'un histogramme (4 bits par canal),
// puis la moyenne des pixels de cette case.
function dominantColor(data) {
  const counts = new Uint32Array(4096);
  for (let j = 0; j < data.length; j += 4) {
    if (data[j + 3] < 200) continue;
    counts[((data[j] >> 4) << 8) | ((data[j + 1] >> 4) << 4) | (data[j + 2] >> 4)]++;
  }
  let best = 0;
  for (let i = 1; i < 4096; i++) if (counts[i] > counts[best]) best = i;
  let r = 0, g = 0, b = 0, n = 0;
  for (let j = 0; j < data.length; j += 4) {
    if (data[j + 3] < 200) continue;
    const bin = ((data[j] >> 4) << 8) | ((data[j + 1] >> 4) << 4) | (data[j + 2] >> 4);
    if (bin !== best) continue;
    r += data[j]; g += data[j + 1]; b += data[j + 2]; n++;
  }
  return n ? { r: r / n, g: g / n, b: b / n } : { r: 0, g: 0, b: 0 };
}

// Analyse l'image : boîte englobante, profil ligne par ligne, couleur dominante,
// et pour chaque case de la grille, si elle contient quelque chose.
function prepareMesh(img) {
  if (meshCache.has(img)) return meshCache.get(img);

  const W = img.naturalWidth || img.width;
  const H = img.naturalHeight || img.height;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const cctx = c.getContext("2d", { willReadFrequently: true });
  cctx.drawImage(img, 0, 0, W, H);
  const data = cctx.getImageData(0, 0, W, H).data;

  // Profil : premier et dernier pixel opaque de chaque ligne (−1 si vide)
  const rowLeft = new Int16Array(H).fill(-1);
  const rowRight = new Int16Array(H).fill(-1);
  let minX = W, minY = H, maxX = -1, maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > ALPHA_MIN) {
        if (rowLeft[y] < 0) rowLeft[y] = x;
        rowRight[y] = x;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; } // image vide

  const bbox = { x0: minX, y0: minY, x1: maxX + 1, y1: maxY + 1 };
  const cellW = (bbox.x1 - bbox.x0) / GRID_COLS;
  const cellH = (bbox.y1 - bbox.y0) / GRID_ROWS;

  // Case "pleine" si au moins un pixel non transparent (marge de 2 px)
  const filled = [];
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let col = 0; col < GRID_COLS; col++) {
      const x0 = Math.max(0, Math.floor(bbox.x0 + col * cellW) - 2);
      const x1 = Math.min(W, Math.ceil(bbox.x0 + (col + 1) * cellW) + 2);
      const y0 = Math.max(0, Math.floor(bbox.y0 + r * cellH) - 2);
      const y1 = Math.min(H, Math.ceil(bbox.y0 + (r + 1) * cellH) + 2);
      let any = false;
      for (let y = y0; y < y1 && !any; y++) {
        for (let x = x0; x < x1; x++) {
          if (data[(y * W + x) * 4 + 3] > 0) { any = true; break; }
        }
      }
      filled.push(any);
    }
  }

  // Sommets de la grille, côté image
  const src = [];
  for (let r = 0; r <= GRID_ROWS; r++) {
    for (let col = 0; col <= GRID_COLS; col++) {
      src.push({ x: bbox.x0 + col * cellW, y: bbox.y0 + r * cellH });
    }
  }

  const mesh = { W, H, bbox, filled, src, rowLeft, rowRight, color: dominantColor(data) };
  meshCache.set(img, mesh);
  return mesh;
}

// Infos utiles aux autres modules (couleur dominante pour lighting.js)
export function getGarmentInfo(img) {
  const m = prepareMesh(img);
  return { bbox: m.bbox, color: m.color };
}

// ---------- Repères du vêtement ----------

function garmentFrame(garment, bbox) {
  const a = garment.anchors;
  const shY = (a.shoulderLeft.y + a.shoulderRight.y) / 2;
  const hipY = a.hipY;
  const torso = hipY - shY;
  return {
    midX: (a.shoulderLeft.x + a.shoulderRight.x) / 2,
    halfW: (a.shoulderRight.x - a.shoulderLeft.x) / 2,
    shY,
    hipY,
    waistY: a.waistY ?? shY + WAIST_T * torso,           // optionnel
    hemY: a.hemY ?? bbox.y1,                             // optionnel
    armpitY: a.armpitY ?? shY + 0.45 * torso,            // optionnel
    sleeveAngle: ((a.sleeveAngle ?? SLEEVE_ANGLE_DEFAULT) * Math.PI) / 180,
  };
}

// Hauteur dans l'image (px) → t (0 = épaules, 1 = hanches)
function yToT(g, y) {
  if (y <= g.shY) return (y - g.shY) / (g.hipY - g.shY);
  if (y <= g.waistY) return (WAIST_T * (y - g.shY)) / (g.waistY - g.shY);
  if (y <= g.hipY) return WAIST_T + ((1 - WAIST_T) * (y - g.waistY)) / (g.hipY - g.waistY);
  return 1 + ((1 - WAIST_T) * (y - g.hipY)) / (g.hipY - g.waistY);
}

// Demi-largeur opaque du vêtement à la hauteur y, d'un côté, en unités u
function garmentExtent(mesh, g, y, side) {
  const yi = clamp(Math.round(y), 0, mesh.H - 1);
  if (mesh.rowLeft[yi] < 0) return 1;
  const ext = side < 0
    ? (g.midX - mesh.rowLeft[yi]) / g.halfW
    : (mesh.rowRight[yi] - g.midX) / g.halfW;
  return Math.max(0.5, ext);
}

// ---------- Repères du corps ----------

// Position corrigée des épaules du vêtement sur le corps.
//   lift   : remonte l'épaule (fraction de la largeur d'épaules)
//   spread : écarte l'épaule (×, autour du milieu des épaules)
// Valeur finale = max(curseur, contour réel mesuré + marge) : le curseur est
// un minimum, la mesure ajoute ce qu'il faut pour couvrir le haut d'origine.
function adjustShoulders(ctrl, fit, real, mesh, g) {
  const { p11, p12, p23, p24 } = ctrl;
  const sw = len(sub(p12, p11));
  const X = unit(sub(p12, p11));
  const up = { x: -X.y, y: X.x };
  const L = Math.max(1, len(sub(lerp(p23, p24, 0.5), lerp(p11, p12, 0.5))));
  const baseLift = fit.shoulderLift ?? 0;
  const baseSpread = fit.shoulderSpread ?? 1;

  const one = (p, outward, topKey, outKey, side) => {
    let lift = baseLift;
    if (real && real[topKey] != null) lift = Math.max(lift, real[topKey] + SHOULDER_TOP_MARGIN);
    lift = clamp(lift, 0, LIFT_MAX);

    let spread = baseSpread;
    if (real && real[outKey] != null) {
      // Ligne du vêtement qui tombe sur la ligne des articulations
      const tRow = (lift * sw) / L / (fit.lengthScale || 1);
      const yRow = g.shY + (Math.min(tRow, WAIST_T) / WAIST_T) * (g.waistY - g.shY);
      const ext = garmentExtent(mesh, g, yRow, side);
      const need = (real[outKey] * sw * SHOULDER_OUT_MARGIN) / (ext * (sw / 2) * fit.widthScale);
      spread = Math.max(spread, need);
    }
    spread = clamp(spread, SPREAD_MIN, SPREAD_MAX);

    const shifted = add(p, add(mul(up, lift * sw), mul(outward, (spread - 1) * (sw / 2))));
    return { point: shifted, lift, spread };
  };

  const s11 = one(p11, mul(X, -1), "top11", "out11", -1); // côté u < 0 de l'image
  const s12 = one(p12, X, "top12", "out12", +1);          // côté u > 0 de l'image
  return { p11: s11.point, p12: s12.point, sw, info: { s11, s12 } };
}

// Construit les "cadres" du torse à partir des points de contrôle lissés.
// Seules les épaules sont corrigées : la taille et les hanches gardent la
// largeur d'origine (shoulderSpread n'élargit QUE le haut).
function buildBodyFrames(ctrl, shoulders) {
  const { p23, p24, nose } = ctrl;
  const p11 = shoulders ? shoulders.p11 : ctrl.p11;
  const p12 = shoulders ? shoulders.p12 : ctrl.p12;
  const hwBase = len(sub(ctrl.p12, ctrl.p11)) / 2; // largeur réelle, sans correction

  // Épaules. X = direction où va le +x de l'image (12 ← 11 : le retournement
  // horizontal est inclus ici, comme le scale(-1) de la version rigide).
  const C0 = lerp(p11, p12, 0.5);
  const X0 = unit(sub(p12, p11));
  const hw0 = len(sub(p12, p11)) / 2;
  const down = { x: X0.y, y: -X0.x }; // perpendiculaire, vers le bas

  // Hanches
  const C1 = lerp(p23, p24, 0.5);
  const X1 = unit(sub(p24, p23));
  const taper = clamp(len(sub(p24, p23)) / (2 * hwBase) / HIP_RATIO_REF, HIP_TAPER_MIN, HIP_TAPER_MAX);
  const hw1 = hwBase * taper;

  // Taille (interpolée, calculée avec la largeur d'origine)
  const Cw = lerp(C0, C1, WAIST_T);
  const Xw = unit(lerp(X0, X1, WAIST_T));
  const hww = (hwBase + (hw1 - hwBase) * WAIST_T) * WAIST_FIT;

  // Base du cou : au-dessus du milieu des épaules, un peu orientée vers le nez
  let up = mul(down, -1);
  if (nose) up = unit(lerp(up, unit(sub(nose, C0)), 0.5));
  const neck = add(C0, mul(up, NECK_HEIGHT * 2 * hwBase));

  const L = Math.max(1, len(sub(C1, C0))); // longueur du torse en pixels

  return { C0, X0, hw0, hwBase, C1, X1, hw1, Cw, Xw, hww, up, down, neck, L };
}

// Cadre du torse à la hauteur t : centre, direction horizontale, demi-largeur
function frameAt(f, t) {
  if (t < 0) {
    // Au-dessus des épaules (col) : on monte vers la base du cou
    return { C: add(f.C0, mul(f.up, -t * f.L)), X: f.X0, hw: f.hw0 };
  }
  if (t <= WAIST_T) {
    const k = t / WAIST_T;
    return { C: lerp(f.C0, f.Cw, k), X: unit(lerp(f.X0, f.Xw, k)), hw: f.hw0 + (f.hww - f.hw0) * k };
  }
  if (t <= 1) {
    const k = (t - WAIST_T) / (1 - WAIST_T);
    return { C: lerp(f.Cw, f.C1, k), X: unit(lerp(f.Xw, f.X1, k)), hw: f.hww + (f.hw1 - f.hww) * k };
  }
  // Sous les hanches (bas du pull) : on prolonge la dernière portion
  const k = (t - 1) / (1 - WAIST_T);
  return { C: add(f.C1, mul(sub(f.C1, f.Cw), k)), X: f.X1, hw: f.hw1 };
}

// Rotation voulue de la manche d'un côté : écart entre l'angle du bras et celui
// de la manche. 0 si le coude n'est pas visible.
function sleeveTarget(shoulder, elbow, outward, down, restAngle) {
  if (!elbow) return 0;
  const v = sub(elbow, shoulder);
  const armAngle = Math.atan2(dot(v, outward), dot(v, down));
  return clamp(armAngle - restAngle, SLEEVE_MIN, SLEEVE_MAX) * SLEEVE_FOLLOW;
}

// ---------- Dessin ----------

// Transformation affine qui envoie le triangle source (s) sur le triangle cible (d)
function setAffine(ctx, s0, s1, s2, d0, d1, d2) {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-6) return false;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - d * s0.y;
  ctx.setTransform(a, b, c, d, e, f);
  return true;
}

// Écarte légèrement les sommets du centre du triangle (recouvrement)
function expand(d0, d1, d2) {
  const cx = (d0.x + d1.x + d2.x) / 3;
  const cy = (d0.y + d1.y + d2.y) / 3;
  return [d0, d1, d2].map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const l = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / l) * OVERLAP_PX, y: p.y + (dy / l) * OVERLAP_PX };
  });
}

function drawTriangle(ctx, img, mesh, s0, s1, s2, d0, d1, d2) {
  const [e0, e1, e2] = expand(d0, d1, d2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(e0.x, e0.y);
  ctx.lineTo(e1.x, e1.y);
  ctx.lineTo(e2.x, e2.y);
  ctx.closePath();
  ctx.clip();

  if (setAffine(ctx, s0, s1, s2, d0, d1, d2)) {
    // On ne copie que le petit rectangle de l'image autour du triangle
    const sx = Math.max(0, Math.floor(Math.min(s0.x, s1.x, s2.x)) - 2);
    const sy = Math.max(0, Math.floor(Math.min(s0.y, s1.y, s2.y)) - 2);
    const ex = Math.min(mesh.W, Math.ceil(Math.max(s0.x, s1.x, s2.x)) + 2);
    const ey = Math.min(mesh.H, Math.ceil(Math.max(s0.y, s1.y, s2.y)) + 2);
    if (ex > sx && ey > sy) {
      ctx.drawImage(img, sx, sy, ex - sx, ey - sy, sx, sy, ex - sx, ey - sy);
    }
  }
  ctx.restore();
}

// Dessine le vêtement déformé sur le corps.
// shoulderReal (facultatif) : contour réel des épaules mesuré par shoulderFit.js
export function drawGarmentWarped(ctx, img, body, garment, shoulderReal = null) {
  if (!body?.ctrl) return;
  const { anchors } = garment;
  const fit = { ...DEFAULT_FIT, ...garment.fit };

  // Même sécurité que la version rigide
  if (anchors.shoulderRight.x - anchors.shoulderLeft.x <= 0) return;
  if (anchors.hipY - anchors.shoulderLeft.y <= 0) return;

  const mesh = prepareMesh(img);
  const g = garmentFrame(garment, mesh.bbox);
  const shoulders = adjustShoulders(body.ctrl, fit, shoulderReal, mesh, g);
  const f = buildBodyFrames(body.ctrl, shoulders);
  const offset = mul(f.down, fit.offsetY * f.L); // réglage "Décalage col"

  // Image → corps, sans les manches
  const mapBase = (p) => {
    const u = (p.x - g.midX) / g.halfW;
    const t = yToT(g, p.y) * fit.lengthScale;
    const fr = frameAt(f, t);
    return add(add(fr.C, mul(fr.X, u * fr.hw * fit.widthScale)), offset);
  };

  // Manches : pivot = épaule du vêtement placée sur le corps.
  // Côté u < 0 de l'image ↔ épaule 11 / coude 13 ; côté u > 0 ↔ 12 / 14.
  // La rotation suit le coude en douceur (pas de saut quand il apparaît).
  const targets = [
    sleeveTarget(body.ctrl.p11, body.ctrl.p13, mul(f.X0, -1), f.down, g.sleeveAngle),
    sleeveTarget(body.ctrl.p12, body.ctrl.p14, f.X0, f.down, g.sleeveAngle),
  ];
  for (let i = 0; i < 2; i++) sleeveRot[i] += SLEEVE_EASE * (targets[i] - sleeveRot[i]);

  const sides = [
    { pivot: mapBase(anchors.shoulderLeft), out: mul(f.X0, -1), rot: sleeveRot[0] },
    { pivot: mapBase(anchors.shoulderRight), out: f.X0, rot: sleeveRot[1] },
  ];
  const armpitBand = 0.2 * (g.armpitY - g.shY);
  const capReach = SLEEVE_CAP_REACH * f.hwBase;

  const map = (p) => {
    const base = mapBase(p);
    const u = (p.x - g.midX) / g.halfW;
    const side = sides[u < 0 ? 0 : 1];

    // Poids de la manche : 0 sur le torse, 1 dans la manche.
    // Sous l'aisselle on exige d'être plus loin du torse (les flancs ne bougent pas).
    const lo = 0.9 + 0.2 * smoothstep(g.armpitY - armpitBand, g.armpitY, p.y);
    const w = smoothstep(lo, lo + 0.25, Math.abs(u));
    if (w <= 0) return base;

    let v = sub(base, side.pivot);

    // 1. Haut de manche élargi : près de l'épaule, on pousse vers l'extérieur
    //    et un peu vers le haut, pour couvrir le tour du bras (deltoïde)
    const near = 1 - smoothstep(0, capReach, len(v));
    if (near > 0) {
      const k = w * near * f.hwBase;
      v = add(v, add(mul(side.out, SLEEVE_CAP_OUT * k), mul(f.down, -SLEEVE_CAP_UP * k)));
    }

    // 2. Rotation de la manche autour de l'épaule, vers le coude
    const ang = side.rot * w;
    if (ang) {
      const cos = Math.cos(ang), sin = Math.sin(ang);
      const a = dot(v, side.out);   // composante vers l'extérieur
      const b = dot(v, f.down);     // composante vers le bas
      v = add(mul(side.out, a * cos + b * sin), mul(f.down, b * cos - a * sin));
    }
    return add(side.pivot, v);
  };

  // Sommets de la grille, côté corps
  const dst = mesh.src.map(map);

  const cols = GRID_COLS + 1;
  for (let r = 0; r < GRID_ROWS; r++) {
    for (let c = 0; c < GRID_COLS; c++) {
      if (!mesh.filled[r * GRID_COLS + c]) continue; // case vide : rien à dessiner
      const i00 = r * cols + c, i10 = i00 + 1, i01 = i00 + cols, i11 = i01 + 1;
      const s = mesh.src, d = dst;
      drawTriangle(ctx, img, mesh, s[i00], s[i10], s[i11], d[i00], d[i10], d[i11]);
      drawTriangle(ctx, img, mesh, s[i00], s[i11], s[i01], d[i00], d[i11], d[i01]);
    }
  }

  // Mémorisé pour le debug (affiché seulement si "Points" est coché)
  lastDebug = {
    points: [
      shoulders.p11, shoulders.p12, f.neck,
      add(f.Cw, mul(f.Xw, f.hww)), add(f.Cw, mul(f.Xw, -f.hww)),
      add(f.C1, mul(f.X1, f.hw1)), add(f.C1, mul(f.X1, -f.hw1)),
    ],
    info: shoulders.info,
  };
}

// Valeurs d'épaules réellement utilisées au dernier dessin (pour l'affichage)
export function getLastShoulderInfo() {
  return lastDebug?.info ?? null;
}

// Debug : points de contrôle du dernier dessin (épaules corrigées, cou, taille, hanches)
export function drawControlPoints(ctx) {
  if (!lastDebug) return;
  ctx.save();
  ctx.fillStyle = "#facc15";
  for (const p of lastDebug.points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Bouton "Arrêter" : on oublie tout
export function resetWarp() {
  sleeveRot[0] = sleeveRot[1] = 0;
  lastDebug = null;
}
