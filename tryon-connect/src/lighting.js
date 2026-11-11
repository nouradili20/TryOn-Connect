// Éclairage et intégration du vêtement dans la scène.
//
// Le vêtement est d'abord dessiné dans un calque à part (getGarmentLayer),
// puis on le retravaille avant de le poser sur l'image :
//  1. Ombrage   : on reprend les plis et ombres du VRAI haut porté (luminance
//                 de la vidéo), ramenés autour de 1, et on les applique au vêtement.
//                 - parties plus sombres que la moyenne → "multiply" (assombrit)
//                 - parties plus claires                → "screen"   (éclaircit)
//                 Le "screen" garde l'effet visible sur un vêtement NOIR, sans
//                 écraser le noir.
//  2. Luminosité globale de la scène : vêtement un peu assombri ou éclairci.
//  3. Ombre douce sous le col.
//  4. Bords adoucis (feather).
//  5. Ombre portée légère sous les bords, au moment de poser le calque.
// Et, avant le vêtement : "Masquer le haut d'origine" (désature et assombrit
// les pixels "vêtements" qui dépassent autour).
//
// Tous les calculs pixel par pixel se font sur de PETITES images (taille du
// masque de segmentation) : c'est rapide, et l'agrandissement adoucit le résultat.
import { CATEGORY } from "./segmenter.js";

const FALLBACK_WIDTH = 160;     // taille de l'analyse si pas de masque
const HIGHLIGHT_GAIN = 0.55;    // force des reflets (mode screen)
const SHADE_MIN = 0.4;          // bornes du rapport luminance / moyenne
const SHADE_MAX = 1.8;
const SCENE_REF = 0.45;         // luminosité "normale" d'une scène (0..1)
const SCENE_MIN = 0.75;         // assombrissement global max
const SCENE_MAX = 1.15;         // éclaircissement global max
const TEMPORAL = 0.15;          // lissage dans le temps des moyennes (anti-scintillement)
const HIDE_GRAY = 115;          // gris utilisé pour assombrir le haut d'origine (≈ ×0,45)

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

// Canvas réutilisable, recréé seulement si la taille change
function slot() {
  let canvas = null, ctx = null;
  return (w, h, opts) => {
    if (!canvas || canvas.width !== w || canvas.height !== h) {
      canvas = makeCanvas(w, h);
      ctx = canvas.getContext("2d", opts);
    }
    return ctx;
  };
}

export function createLighting() {
  const garmentSlot = slot();  // calque du vêtement (pleine taille)
  const workSlot = slot();     // calque de travail (pleine taille)
  const halfSlot = slot();     // demi-taille, pour le flou des bords
  const darkSlot = slot();     // petite carte "multiply"
  const lightSlot = slot();    // petite carte "screen"
  const hideSlot = slot();     // petit masque "haut d'origine" (désaturation)
  const fillSlot = slot();     // petit masque "haut d'origine" (remplissage couleur)
  const dilateSlot = slot();   // masque du vêtement réduit et dilaté (relu sur le CPU)

  // Petite copie de la vidéo, lue sur le CPU
  const videoCanvas = document.createElement("canvas");
  const videoCtx = videoCanvas.getContext("2d", { willReadFrequently: true });

  let darkData = null, lightData = null, hideData = null, fillData = null;
  let clothesMean = null;   // luminance moyenne du haut porté (lissée)
  let sceneFactor = 1;      // adaptation globale (lissée)
  let frame = null;         // { w, h, lum: Float32Array, cats: Uint8Array|null }

  // Analyse l'image vidéo actuelle (à appeler une fois par nouvelle image).
  function analyze(video, mask) {
    const w = mask ? mask.width : FALLBACK_WIDTH;
    const h = mask ? mask.height : Math.round((video.videoHeight / video.videoWidth) * FALLBACK_WIDTH);
    if (videoCanvas.width !== w || videoCanvas.height !== h) {
      videoCanvas.width = w;
      videoCanvas.height = h;
    }
    videoCtx.drawImage(video, 0, 0, w, h);
    const px = videoCtx.getImageData(0, 0, w, h).data;

    if (!frame || frame.lum.length !== w * h) frame = { w, h, lum: new Float32Array(w * h), cats: null };
    frame.w = w;
    frame.h = h;
    frame.cats = mask ? mask.data : null;

    let sceneSum = 0, clothesSum = 0, clothesCount = 0;
    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      const l = (0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2]) / 255;
      frame.lum[i] = l;
      sceneSum += l;
      if (frame.cats && frame.cats[i] === CATEGORY.CLOTHES) {
        clothesSum += l;
        clothesCount++;
      }
    }

    // Luminosité globale → facteur doux (racine carrée), lissé dans le temps
    const sceneMean = sceneSum / (w * h);
    const target = Math.min(SCENE_MAX, Math.max(SCENE_MIN, Math.sqrt(sceneMean / SCENE_REF)));
    sceneFactor += TEMPORAL * (target - sceneFactor);

    // Moyenne du haut porté (il faut assez de pixels pour qu'elle ait un sens)
    if (clothesCount > w * h * 0.01) {
      const m = Math.max(0.03, clothesSum / clothesCount);
      clothesMean = clothesMean == null ? m : clothesMean + TEMPORAL * (m - clothesMean);
    } else {
      clothesMean = null;
    }
  }

  // Fabrique les petites cartes d'ombrage (multiply et screen)
  function buildShadeMaps(amount) {
    const { w, h, lum, cats } = frame;
    const dctx = darkSlot(w, h);
    const lctx = lightSlot(w, h);
    if (!darkData || darkData.width !== w || darkData.height !== h) {
      darkData = dctx.createImageData(w, h);
      lightData = lctx.createImageData(w, h);
    }
    const dk = darkData.data, lt = lightData.data;
    const useLocal = cats && clothesMean != null && amount > 0;
    const globalDark = Math.min(1, sceneFactor);
    const globalLight = Math.max(0, sceneFactor - 1) * 0.5;

    for (let i = 0, j = 0; i < w * h; i++, j += 4) {
      // s = 1 : neutre. Seuls les pixels du vrai haut portent des plis.
      let s = 1;
      if (useLocal && cats[i] === CATEGORY.CLOTHES) {
        s = lum[i] / clothesMean;
        s = s < SHADE_MIN ? SHADE_MIN : s > SHADE_MAX ? SHADE_MAX : s;
      }
      const d = globalDark * (s < 1 ? 1 - amount * (1 - s) : 1);
      const l = globalLight + (s > 1 ? amount * (s - 1) * HIGHLIGHT_GAIN : 0);
      const dv = Math.round(255 * d);
      const lv = Math.round(255 * Math.min(1, l));
      dk[j] = dk[j + 1] = dk[j + 2] = dv; dk[j + 3] = 255;
      lt[j] = lt[j + 1] = lt[j + 2] = lv; lt[j + 3] = 255;
    }
    dctx.putImageData(darkData, 0, 0);
    lctx.putImageData(lightData, 0, 0);
    return { dark: dctx.canvas, light: lctx.canvas };
  }

  // Applique une petite carte sur le calque du vêtement avec un mode de fusion,
  // en la limitant d'abord à la forme du vêtement.
  function blendMap(gctx, map, mode) {
    const W = gctx.canvas.width, H = gctx.canvas.height;
    const wctx = workSlot(W, H);
    wctx.globalCompositeOperation = "source-over";
    wctx.clearRect(0, 0, W, H);
    wctx.imageSmoothingEnabled = true;
    wctx.imageSmoothingQuality = "high";
    wctx.drawImage(map, 0, 0, W, H);
    wctx.globalCompositeOperation = "destination-in"; // seulement sur le vêtement
    wctx.drawImage(gctx.canvas, 0, 0);
    wctx.globalCompositeOperation = "source-over";

    gctx.globalCompositeOperation = mode;
    gctx.drawImage(wctx.canvas, 0, 0);
    gctx.globalCompositeOperation = "source-over";
  }

  return {
    // Calque vide (pleine taille) où dessiner le vêtement
    getGarmentLayer(W, H) {
      const g = garmentSlot(W, H);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "source-over";
      g.clearRect(0, 0, W, H);
      return g;
    },

    analyze,

    // 1 + 2. Ombrage (plis du vrai haut) + luminosité globale
    shade(gctx, amount) {
      if (!frame) return;
      // Rien à faire : ombrage coupé et scène "normale" → on économise 2 passes
      if (amount <= 0 && Math.abs(sceneFactor - 1) < 0.01) return;
      const maps = buildShadeMaps(amount);
      blendMap(gctx, maps.dark, "multiply");
      blendMap(gctx, maps.light, "screen");
    },

    // 3. Ombre douce juste sous le col (garde la forme du vêtement : source-atop)
    collarShadow(gctx, body, fit, amount) {
      if (amount <= 0 || !body) return;
      const down = { x: -Math.sin(body.angle), y: Math.cos(body.angle) };
      const L = body.torsoLength;
      const k = (fit.offsetY ?? 0) * L + 0.03 * L;
      const cx = body.x + down.x * k;
      const cy = body.y + down.y * k;
      const rx = body.shoulderWidth * 0.32;
      const ry = L * 0.1;

      gctx.save();
      gctx.globalCompositeOperation = "source-atop";
      gctx.translate(cx, cy);
      gctx.rotate(body.angle);
      gctx.scale(1, ry / rx);
      const grad = gctx.createRadialGradient(0, 0, 0, 0, 0, rx);
      grad.addColorStop(0, `rgba(0,0,0,${(0.35 * amount).toFixed(3)})`);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      gctx.fillStyle = grad;
      gctx.fillRect(-rx, -rx, rx * 2, rx * 2);
      gctx.restore();
    },

    // 4. Bords adoucis : alpha du vêtement × version floutée de lui-même
    feather(gctx, amount) {
      if (amount <= 0) return;
      const W = gctx.canvas.width, H = gctx.canvas.height;
      const hw = Math.max(1, Math.round(W / 2)), hh = Math.max(1, Math.round(H / 2));
      const hctx = halfSlot(hw, hh);
      const radius = amount * (W / 120); // ≈ 10 px max en 1280 px de large
      hctx.clearRect(0, 0, hw, hh);
      hctx.filter = `blur(${(radius / 2).toFixed(1)}px)`; // demi-taille → rayon / 2
      hctx.drawImage(gctx.canvas, 0, 0, hw, hh);
      hctx.filter = "none";

      gctx.globalCompositeOperation = "destination-in";
      gctx.drawImage(hctx.canvas, 0, 0, W, H);
      gctx.globalCompositeOperation = "source-over";
    },

    // 5. Pose le calque du vêtement sur l'image, avec une ombre portée légère
    composite(ctx, gctx, shadowAmount) {
      const W = ctx.canvas.width;
      ctx.save();
      if (shadowAmount > 0) {
        ctx.shadowColor = `rgba(0,0,0,${(0.45 * shadowAmount).toFixed(3)})`;
        ctx.shadowBlur = W / 90;
        ctx.shadowOffsetY = W / 250;
      }
      ctx.drawImage(gctx.canvas, 0, 0);
      ctx.restore();
    },

    // Option : fait disparaître le haut d'origine qui dépasse autour du vêtement.
    //  - Dans une BANDE autour du vêtement virtuel (masque du vêtement dilaté de
    //    bandPx) : les pixels "vêtements" sont REMPLIS avec la couleur dominante
    //    du vêtement virtuel, avec le même ombrage que lui.
    //  - Plus loin (mais dans la zone du torse) : simple désaturation + assombrissement.
    // region = rectangle (fraction 0..1 de l'image) autour du torse, pour ne pas
    // toucher au pantalon. À appeler APRÈS avoir préparé le calque du vêtement
    // (gctx) et AVANT de le poser sur l'image.
    // recompute = false → on réutilise le dernier résultat (mode Éco).
    hideOriginal(ctx, gctx, mask, region, amount, color, bandPx, recompute) {
      if (amount <= 0 || !mask) return;
      const { width: w, height: h, data: cats } = mask;
      const W = ctx.canvas.width, H = ctx.canvas.height;
      const sctx = hideSlot(w, h);
      const fctx = fillSlot(w, h);

      if (recompute || !hideData || hideData.width !== w || hideData.height !== h) {
        if (!hideData || hideData.width !== w || hideData.height !== h) {
          hideData = sctx.createImageData(w, h);
          fillData = fctx.createImageData(w, h);
        }

        // 1. Masque du vêtement, réduit et DILATÉ : on le dessine plusieurs fois
        //    décalé sur deux cercles (rapide, et marche sans ctx.filter)
        const dctx = dilateSlot(w, h);
        dctx.clearRect(0, 0, w, h);
        const r = (bandPx * w) / W; // rayon en pixels du masque
        dctx.drawImage(gctx.canvas, 0, 0, w, h);
        for (const ring of [0.5, 1]) {
          for (let k = 0; k < 8; k++) {
            const a = (k * Math.PI) / 4;
            dctx.drawImage(gctx.canvas, Math.cos(a) * r * ring, Math.sin(a) * r * ring, w, h);
          }
        }
        const dil = dctx.getImageData(0, 0, w, h).data;

        // 2. Ombrage du vêtement (mêmes cartes que shade()), si disponibles
        const shadeOk = darkData && darkData.width === w && darkData.height === h;
        const dk = shadeOk ? darkData.data : null;
        const lt = shadeOk ? lightData.data : null;

        const hd = hideData.data, fd = fillData.data;
        const x0 = region.x0 * w, x1 = region.x1 * w, y0 = region.y0 * h, y1 = region.y1 * h;
        for (let y = 0, i = 0; y < h; y++) {
          for (let x = 0; x < w; x++, i++) {
            const j = i * 4;
            hd[j + 3] = 0;
            fd[j + 3] = 0;
            if (cats[i] !== CATEGORY.CLOTHES) continue;
            if (x < x0 || x > x1 || y < y0 || y > y1) continue;

            if (dil[j + 3] > 8) {
              // Dans la bande : couleur du vêtement × multiply, puis screen
              let r2 = color.r, g2 = color.g, b2 = color.b;
              if (dk) {
                const m = dk[j] / 255, l = lt[j] / 255;
                r2 = 255 - (255 - r2 * m) * (1 - l);
                g2 = 255 - (255 - g2 * m) * (1 - l);
                b2 = 255 - (255 - b2 * m) * (1 - l);
              }
              fd[j] = r2; fd[j + 1] = g2; fd[j + 2] = b2; fd[j + 3] = 255;
            } else {
              // Plus loin : on éteint juste la couleur
              hd[j] = hd[j + 1] = hd[j + 2] = HIDE_GRAY;
              hd[j + 3] = 255;
            }
          }
        }
        sctx.putImageData(hideData, 0, 0);
        fctx.putImageData(fillData, 0, 0);
      }

      // 3. Agrandissement flouté (bords doux) puis application sur l'image
      const wctx = workSlot(W, H);
      const blur = `blur(${Math.max(1, W / 300).toFixed(1)}px)`;
      const upscale = (small) => {
        wctx.globalCompositeOperation = "source-over";
        wctx.clearRect(0, 0, W, H);
        wctx.imageSmoothingEnabled = true;
        wctx.imageSmoothingQuality = "high";
        wctx.filter = blur;
        wctx.drawImage(small, 0, 0, W, H);
        wctx.filter = "none";
        return wctx.canvas;
      };

      ctx.save();
      const desat = upscale(sctx.canvas);
      ctx.globalCompositeOperation = "saturation"; // gris → enlève la couleur
      ctx.globalAlpha = amount;
      ctx.drawImage(desat, 0, 0);
      ctx.globalCompositeOperation = "multiply";   // puis assombrit doucement
      ctx.globalAlpha = amount * 0.8;
      ctx.drawImage(desat, 0, 0);

      const fill = upscale(fctx.canvas);
      ctx.globalCompositeOperation = "source-over"; // remplissage couleur du vêtement
      ctx.globalAlpha = amount;
      ctx.drawImage(fill, 0, 0);
      ctx.restore();
    },

    // Changement d'article : le remplissage dépend de l'image du vêtement
    resetFill() {
      hideData = fillData = null;
    },

    reset() {
      frame = null;
      hideData = fillData = null; // pas de vieux remplissage au redémarrage
      clothesMean = null;
      sceneFactor = 1;
    },
  };
}
