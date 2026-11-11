// Occlusion : redessine PAR-DESSUS le vêtement les parties du corps qui
// doivent passer devant (cheveux, avant-bras et mains).
//
// Principe :
//  1. À partir du masque de segmentation (petite taille), on fabrique un
//     masque "occultant" : cheveux + peau située autour des avant-bras.
//  2. On l'agrandit à la taille du canvas avec un léger flou (bords doux).
//  3. On ne garde de la vidéo que les pixels de ce masque, et on les colle
//     sur l'image finale, au-dessus du vêtement.
import { CATEGORY } from "./segmenter.js";

const MIN_VISIBILITY = 0.5;

// Segments coude → poignet (13→15 bras gauche, 14→16 bras droit)
const FOREARMS = [
  [13, 15],
  [14, 16],
];

// Zone autour de l'avant-bras, en fraction de la longueur coude→poignet
const ARM_RADIUS = 0.35;     // épaisseur de la zone (rayon)
const HAND_EXTENSION = 0.6;  // on prolonge après le poignet pour inclure la main

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Calcule les "capsules" (segment + rayon) des avant-bras visibles,
// en coordonnées du masque.
function forearmCapsules(landmarks, w, h) {
  const capsules = [];
  if (!landmarks) return capsules;

  for (const [elbowId, wristId] of FOREARMS) {
    const e = landmarks[elbowId];
    const wr = landmarks[wristId];
    if ((e.visibility ?? 1) < MIN_VISIBILITY || (wr.visibility ?? 1) < MIN_VISIBILITY) continue;

    const ax = e.x * w, ay = e.y * h;
    const wx = wr.x * w, wy = wr.y * h;
    const len = Math.hypot(wx - ax, wy - ay);
    if (len < 1) continue;

    // Fin de la capsule : au-delà du poignet, pour couvrir la main
    const bx = wx + ((wx - ax) / len) * len * HAND_EXTENSION;
    const by = wy + ((wy - ay) / len) * len * HAND_EXTENSION;
    const r = Math.max(3, len * ARM_RADIUS);

    capsules.push({ ax, ay, bx, by, r2: r * r });
  }
  return capsules;
}

// Distance au carré entre un point et un segment [a, b]
function distToSegment2(px, py, c) {
  const vx = c.bx - c.ax, vy = c.by - c.ay;
  const len2 = vx * vx + vy * vy;
  let t = ((px - c.ax) * vx + (py - c.ay) * vy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = px - (c.ax + t * vx);
  const dy = py - (c.ay + t * vy);
  return dx * dx + dy * dy;
}

export function createOcclusion() {
  let small = null;      // masque occultant, taille du masque de segmentation
  let smallCtx = null;
  let imageData = null;
  let layer = null;      // calque pleine taille : pixels vidéo à remettre devant
  let layerCtx = null;
  const supportsFilter = "filter" in CanvasRenderingContext2D.prototype;

  function ensureSmall(w, h) {
    if (small && small.width === w && small.height === h) return;
    small = makeCanvas(w, h);
    smallCtx = small.getContext("2d");
    imageData = smallCtx.createImageData(w, h);
    // Couleur blanche partout : seul l'alpha (canal 4) compte
    const d = imageData.data;
    for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = 255; d[i + 3] = 0; }
  }

  function ensureLayer(w, h) {
    if (layer && layer.width === w && layer.height === h) return;
    layer = makeCanvas(w, h);
    layerCtx = layer.getContext("2d");
  }

  // 1. Construit le masque occultant (petite taille) à partir des catégories
  function buildMask(mask, landmarks) {
    const { width: w, height: h, data: cats } = mask;
    ensureSmall(w, h);
    const capsules = forearmCapsules(landmarks, w, h);
    const out = imageData.data;

    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i++) {
        const c = cats[i];
        let a = 0;
        if (c === CATEGORY.HAIR) {
          a = 255;
        } else if (c === CATEGORY.BODY_SKIN && capsules.length) {
          // Peau du corps : seulement près des avant-bras (jamais le cou ou le torse)
          for (const cap of capsules) {
            if (distToSegment2(x + 0.5, y + 0.5, cap) <= cap.r2) { a = 255; break; }
          }
        }
        out[i * 4 + 3] = a;
      }
    }
    smallCtx.putImageData(imageData, 0, 0);
  }

  return {
    // Dessine sur ctx les pixels vidéo qui doivent passer devant le vêtement.
    draw(ctx, video, mask, landmarks) {
      if (!mask) return;
      const W = ctx.canvas.width, H = ctx.canvas.height;

      buildMask(mask, landmarks);
      ensureLayer(W, H);

      // 2. Masque agrandi + flou léger = bords doux, sans escalier
      layerCtx.globalCompositeOperation = "source-over";
      layerCtx.clearRect(0, 0, W, H);
      layerCtx.imageSmoothingEnabled = true;
      layerCtx.imageSmoothingQuality = "high";
      if (supportsFilter) layerCtx.filter = `blur(${Math.max(1, W / 450).toFixed(1)}px)`;
      layerCtx.drawImage(small, 0, 0, W, H);
      if (supportsFilter) layerCtx.filter = "none";

      // 3. On ne garde la vidéo que là où le masque est opaque
      layerCtx.globalCompositeOperation = "source-in";
      layerCtx.drawImage(video, 0, 0, W, H);
      layerCtx.globalCompositeOperation = "source-over";

      ctx.drawImage(layer, 0, 0);
    },

    reset() {
      small = smallCtx = imageData = null;
      layer = layerCtx = null;
    },
  };
}
