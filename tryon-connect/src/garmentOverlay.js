// Mesure le corps et dessine un vêtement dessus.
import { DEFAULT_FIT } from "./garments.js";

const MIN_VISIBILITY = 0.5;
// Si les hanches ne sont pas visibles : épaules → hanches ≈ 1,3 × largeur d'épaules
const TORSO_RATIO_FALLBACK = 1.3;

const imageCache = new Map();

export function loadGarmentImage(src) {
  if (imageCache.has(src)) return imageCache.get(src);

  const promise = new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image introuvable : " + src));
    img.src = src;
  });

  imageCache.set(src, promise);
  // Échec : on l'oublie, pour pouvoir réessayer plus tard
  promise.catch(() => imageCache.delete(src));
  return promise;
}

// Oublie une image (article supprimé ou redétouré)
export function forgetGarmentImage(src) {
  imageCache.delete(src);
}

// Transforme les points MediaPipe en mesures du corps, en pixels.
// Retourne null si les épaules ne sont pas visibles.
export function measureBody(landmarks, width, height) {
  const visible = (i) => (landmarks[i].visibility ?? 1) > MIN_VISIBILITY;
  const toPx = (i) => ({ x: landmarks[i].x * width, y: landmarks[i].y * height });

  if (!visible(11) || !visible(12)) return null;

  // Image caméra non inversée : épaule droite de la personne (12) à gauche de l'image
  const imgLeft = toPx(12);
  const imgRight = toPx(11);

  const x = (imgLeft.x + imgRight.x) / 2;
  const y = (imgLeft.y + imgRight.y) / 2;
  const shoulderWidth = Math.hypot(imgRight.x - imgLeft.x, imgRight.y - imgLeft.y);
  const angle = Math.atan2(imgRight.y - imgLeft.y, imgRight.x - imgLeft.x);

  let torsoLength;
  if (visible(23) && visible(24)) {
    const a = toPx(23);
    const b = toPx(24);
    torsoLength = Math.hypot((a.x + b.x) / 2 - x, (a.y + b.y) / 2 - y);
  } else {
    torsoLength = shoulderWidth * TORSO_RATIO_FALLBACK;
  }

  // --- Points de contrôle pour la déformation (meshWarp.js) ---
  const p11 = toPx(11);
  const p12 = toPx(12);
  // "Bas" du corps = perpendiculaire à la ligne des épaules
  const down = { x: -Math.sin(angle), y: Math.cos(angle) };

  let p23, p24;
  if (visible(23) && visible(24)) {
    p23 = toPx(23);
    p24 = toPx(24);
  } else {
    // Hanches estimées sous les épaules (même ratio que torsoLength)
    const d = shoulderWidth * TORSO_RATIO_FALLBACK;
    p23 = { x: p11.x + down.x * d, y: p11.y + down.y * d };
    p24 = { x: p12.x + down.x * d, y: p12.y + down.y * d };
  }

  const ctrl = {
    p11, p12, p23, p24,
    nose: visible(0) ? toPx(0) : null,
    p13: visible(13) ? toPx(13) : null, // coudes (orientation des manches)
    p14: visible(14) ? toPx(14) : null,
  };

  return { x, y, angle, shoulderWidth, torsoLength, ctrl };
}

// Dessine le vêtement selon les mesures du corps, ses ancres et ses réglages.
export function drawGarment(ctx, img, body, garment) {
  const { anchors } = garment;
  const fit = { ...DEFAULT_FIT, ...garment.fit };

  const garmentShoulderWidth = anchors.shoulderRight.x - anchors.shoulderLeft.x;
  const garmentTorsoLength = anchors.hipY - anchors.shoulderLeft.y;

  // Sécurité : ancres non remplies ou incohérentes → on ne dessine rien
  if (garmentShoulderWidth <= 0 || garmentTorsoLength <= 0) return;

  const scaleX = (body.shoulderWidth / garmentShoulderWidth) * fit.widthScale;
  const scaleY = (body.torsoLength / garmentTorsoLength) * fit.lengthScale;

  const anchorMidX = (anchors.shoulderLeft.x + anchors.shoulderRight.x) / 2;
  const anchorMidY = (anchors.shoulderLeft.y + anchors.shoulderRight.y) / 2;

  ctx.save();
  ctx.translate(body.x, body.y);                    // 1. entre les épaules
  ctx.rotate(body.angle);                           // 2. inclinaison des épaules
  ctx.translate(0, fit.offsetY * body.torsoLength); // 3. décalage du col, le long du corps
  ctx.scale(-scaleX, scaleY);                       // 4. taille (+ retournement pour le miroir CSS)
  ctx.drawImage(img, -anchorMidX, -anchorMidY);     // 5. ancre au centre
  ctx.restore();
}