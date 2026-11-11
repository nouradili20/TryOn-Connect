// Contour RÉEL des épaules, mesuré dans le masque de segmentation.
//
// Les points 11/12 de MediaPipe sont sur l'articulation : plus bas et plus à
// l'intérieur que le vrai contour de l'épaule. Ici, depuis chaque point
// d'épaule, on avance dans le masque :
//   - vers le HAUT        → jusqu'au bord supérieur de l'épaule
//   - vers l'EXTÉRIEUR    → jusqu'au bord extérieur de l'épaule
// tant qu'on reste sur le "corps" (vêtements, peau du corps, accessoires).
// Les distances sont exprimées en fraction de la largeur d'épaules (stable
// quand on s'approche ou s'éloigne de la caméra) et lissées dans le temps.
import { CATEGORY } from "./segmenter.js";

const MIN_VISIBILITY = 0.5;
const MAX_SCAN = 0.45;       // on ne cherche pas plus loin que 45 % de la largeur d'épaules
const MAX_GAP = 2;           // trous tolérés dans le masque (en pixels du masque)
const HOLD_FRAMES = 15;      // garde la dernière mesure si elle devient impossible

const isBody = (c) => c === CATEGORY.CLOTHES || c === CATEGORY.BODY_SKIN || c === CATEGORY.OTHERS;

export function createShoulderTracker() {
  // Valeurs lissées (fractions de la largeur d'épaules), null = inconnu
  const state = { top11: null, top12: null, out11: null, out12: null };
  const hold = { top11: 0, top12: 0, out11: 0, out12: 0 };
  let debug = [];

  // Avance depuis p dans la direction dir. Renvoie la distance (px canvas) du
  // dernier pixel "corps", ou null si le bord est caché (cheveux, visage)
  // ou introuvable (bras levé, par exemple).
  function scan(mask, p, dir, maxDist, scale) {
    const { width: mw, height: mh, data } = mask;
    const step = 1 / scale; // 1 pixel du masque, en pixels canvas
    const catAt = (x, y) => {
      const mx = Math.floor(x * scale), my = Math.floor(y * scale);
      if (mx < 0 || my < 0 || mx >= mw || my >= mh) return CATEGORY.BACKGROUND;
      return data[my * mw + mx];
    };

    if (!isBody(catAt(p.x, p.y))) return null;
    let last = 0, gap = 0;
    for (let d = step; d <= maxDist; d += step) {
      const c = catAt(p.x + dir.x * d, p.y + dir.y * d);
      if (isBody(c)) { last = d; gap = 0; continue; }
      if (++gap > MAX_GAP) {
        // Bord caché par des cheveux ou le visage : on ne sait pas
        if (c === CATEGORY.HAIR || c === CATEGORY.FACE_SKIN) return null;
        return last;
      }
    }
    return null; // jamais sorti du corps : mesure non fiable
  }

  function smooth(key, value, alpha) {
    if (value == null) {
      if (++hold[key] > HOLD_FRAMES) state[key] = null;
      return;
    }
    hold[key] = 0;
    state[key] = state[key] == null ? value : state[key] + alpha * (value - state[key]);
  }

  return {
    // À appeler une fois par nouvelle image vidéo
    update(landmarks, mask, W, H, smoothing) {
      debug = [];
      if (!landmarks || !mask) {
        for (const k in state) smooth(k, null, 0);
        return state;
      }
      const vis = (i) => (landmarks[i].visibility ?? 1) > MIN_VISIBILITY;
      if (!vis(11) || !vis(12)) {
        for (const k in state) smooth(k, null, 0);
        return state;
      }

      const p11 = { x: landmarks[11].x * W, y: landmarks[11].y * H };
      const p12 = { x: landmarks[12].x * W, y: landmarks[12].y * H };
      const sw = Math.hypot(p12.x - p11.x, p12.y - p11.y);
      if (sw < 10) return state;

      const X = { x: (p12.x - p11.x) / sw, y: (p12.y - p11.y) / sw }; // 11 → 12
      const up = { x: -X.y, y: X.x };                                  // vers le haut
      const scale = mask.width / W;
      const max = MAX_SCAN * sw;
      const alpha = 1 - smoothing;

      const sides = [
        { p: p11, out: { x: -X.x, y: -X.y }, top: "top11", outKey: "out11" },
        { p: p12, out: X, top: "top12", outKey: "out12" },
      ];
      for (const s of sides) {
        const t = scan(mask, s.p, up, max, scale);
        const o = scan(mask, s.p, s.out, max, scale);
        smooth(s.top, t == null ? null : t / sw, alpha);
        // Bord extérieur mesuré depuis le MILIEU des épaules
        smooth(s.outKey, o == null ? null : (sw / 2 + o) / sw, alpha);

        // Debug : points du contour réel (affichés avec "Points")
        if (state[s.top] != null) {
          const d = state[s.top] * sw;
          debug.push({ x: s.p.x + up.x * d, y: s.p.y + up.y * d });
        }
        if (state[s.outKey] != null) {
          const d = state[s.outKey] * sw - sw / 2;
          debug.push({ x: s.p.x + s.out.x * d, y: s.p.y + s.out.y * d });
        }
      }
      return state;
    },

    get() {
      return state;
    },

    // Points du contour réel (vert) pour le debug
    drawDebug(ctx) {
      ctx.save();
      ctx.fillStyle = "#4ade80";
      for (const p of debug) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    },

    reset() {
      for (const k in state) { state[k] = null; hold[k] = 0; }
      debug = [];
    },
  };
}
