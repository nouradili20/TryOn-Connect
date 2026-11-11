// MODE RAPIDE : moteur local MediaPipe + Canvas (aucun serveur contacté).
// Code déplacé depuis main.js sans changer son comportement.
// Interface commune aux moteurs : start(videoElement, outputElement), setGarment(garment), stop().
import { startCamera, stopCamera } from "../camera.js";
import { initPoseDetector, detectPose } from "../poseDetector.js";
import { resizeCanvas, drawVideo, drawSkeleton, clearCanvas } from "../renderer.js";
import { loadGarmentImage, measureBody, drawGarment } from "../garmentOverlay.js";
import { createSmoother } from "../smoothing.js";
import { DEFAULT_FIT } from "../garments.js";
import { initSegmenter, segment, getLastMask, resetSegmenter } from "../segmenter.js";
import { createOcclusion } from "../occlusion.js";
import {
  drawGarmentWarped, drawControlPoints, getGarmentInfo, getLastShoulderInfo, resetWarp,
} from "../meshWarp.js";
import { createLighting } from "../lighting.js";
import { createShoulderTracker } from "../shoulderFit.js";

const $ = (id) => document.getElementById(id);

// setStatus : affiche un message dans la barre d'état
export function createFastEngine({ setStatus }) {
  // Réglages lus en direct dans l'interface (propres au mode rapide)
  const chkSkeleton = $("chk-skeleton");
  const chkOcclusion = $("chk-occlusion");
  const chkEco = $("chk-eco");
  const chkWarp = $("chk-warp");
  const chkAutoShoulder = $("chk-auto-shoulder");
  const fpsEl = $("fps");
  const shoulderInfoEl = $("shoulder-info");
  const rngSmooth = $("rng-smooth");
  const rngShade = $("rng-shade");
  const rngFeather = $("rng-feather");
  const rngHide = $("rng-hide");

  let video = null;
  let canvas = null;
  let ctx = null;

  let rafId = null;
  let lastVideoTime = -1;
  let lastLandmarks = null;
  let body = null; // mesures lissées du corps

  const smoother = createSmoother();
  const occlusion = createOcclusion();
  const lighting = createLighting();
  const shoulderTracker = createShoulderTracker();
  let segmenterReady = false;
  let fillDirty = true; // le remplissage "haut d'origine" doit être recalculé
  let frameIndex = 0;   // compteur d'images vidéo traitées

  let currentGarment = null;
  let garmentImg = null;
  let garmentColor = { r: 0, g: 0, b: 0 }; // couleur dominante (calculée au chargement)
  let selectToken = 0; // évite qu'un ancien chargement lent écrase le plus récent

  // Compteur FPS : images vidéo réellement traitées par seconde
  const fps = { frames: 0, since: 0 };

  function updateFps(now) {
    fps.frames++;
    const elapsed = now - fps.since;
    if (elapsed >= 500) {
      const value = (fps.frames * 1000) / elapsed;
      fpsEl.textContent = `${value.toFixed(0)} FPS`;
      fpsEl.classList.toggle("low", value < 20);
      updateShoulderInfo();
      fps.frames = 0;
      fps.since = now;
    }
  }

  // Affiche les valeurs d'épaules réellement utilisées (curseur ou mesure auto)
  function updateShoulderInfo() {
    const info = chkWarp.checked ? getLastShoulderInfo() : null;
    if (!info || !body) {
      shoulderInfoEl.textContent = "";
      return;
    }
    const f = (s) => `hauteur ${s.lift.toFixed(2)} / largeur ${s.spread.toFixed(2)}`;
    shoulderInfoEl.textContent =
      `Épaules utilisées — gauche de l'image : ${f(info.s11)} · droite : ${f(info.s12)}`;
  }

  // Zone autour du torse (en fraction de l'image) pour "Masquer le haut d'origine"
  function torsoRegion(b, fit) {
    const W = canvas.width, H = canvas.height;
    const sw = b.shoulderWidth, L = b.torsoLength;
    return {
      x0: (b.x - 1.4 * sw) / W,
      x1: (b.x + 1.4 * sw) / W,
      y0: (b.y - 0.35 * L) / H,
      y1: (b.y + (1.15 * fit.lengthScale + fit.offsetY) * L) / H,
    };
  }

  function loop() {
    const occlusionOn = chkOcclusion.checked && segmenterReady;
    const shading = Number(rngShade.value);
    const featherAmount = Number(rngFeather.value);
    const hideAmount = Number(rngHide.value);
    const autoShoulder = chkAutoShoulder.checked && chkWarp.checked;
    // La segmentation sert à l'occlusion, à l'ombrage, au masquage du haut
    // et à la mesure du contour réel des épaules
    const needMask =
      segmenterReady && (occlusionOn || shading > 0 || hideAmount > 0 || autoShoulder);

    // Nouvelle image vidéo → nouvelle détection → nouvelle mesure lissée
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const now = performance.now();
      lastLandmarks = detectPose(video, now);

      const measure = lastLandmarks
        ? measureBody(lastLandmarks, canvas.width, canvas.height)
        : null;
      body = smoother.update(measure, Number(rngSmooth.value));

      // Segmentation : à chaque image, ou une sur deux en mode Éco
      // (entre-temps on réutilise le dernier masque)
      const heavyFrame = !chkEco.checked || frameIndex % 2 === 0;
      if (needMask && heavyFrame) {
        segment(video, now);
        fillDirty = true; // nouveau masque → nouveau remplissage
      }
      // Contour réel des épaules (quelques centaines de lectures : très léger)
      if (autoShoulder) {
        shoulderTracker.update(
          lastLandmarks, getLastMask(), canvas.width, canvas.height, Number(rngSmooth.value)
        );
      }
      // Analyse de la lumière (petite image, une fois par image vidéo)
      lighting.analyze(video, needMask ? getLastMask() : null);
      frameIndex++;
      updateFps(now);
    }

    // Ordre de composition :
    // vidéo → (haut d'origine atténué) → vêtement éclairé → cheveux/avant-bras → squelette
    drawVideo(ctx, video);

    if (body && garmentImg) {
      const mask = needMask ? getLastMask() : null;
      const fit = { ...DEFAULT_FIT, ...currentGarment.fit };

      // Le vêtement est dessiné dans son propre calque, puis retravaillé
      const g = lighting.getGarmentLayer(canvas.width, canvas.height);
      if (chkWarp.checked) {
        // version déformée (+ contour réel des épaules si "Épaules auto")
        drawGarmentWarped(g, garmentImg, body, currentGarment,
          autoShoulder ? shoulderTracker.get() : null);
      } else {
        drawGarment(g, garmentImg, body, currentGarment); // version rigide de secours
      }
      lighting.shade(g, shading);
      lighting.collarShadow(g, body, fit, shading);
      lighting.feather(g, featherAmount);

      // Haut d'origine : rempli autour du vêtement (avant de poser le vêtement).
      // Recalculé seulement quand un nouveau masque arrive (une image sur deux en Éco).
      if (hideAmount > 0 && mask) {
        lighting.hideOriginal(ctx, g, mask, torsoRegion(body, fit), hideAmount,
          garmentColor, 0.18 * body.shoulderWidth, fillDirty);
        fillDirty = false;
      }

      lighting.composite(ctx, g, shading);

      if (occlusionOn) {
        occlusion.draw(ctx, video, getLastMask(), lastLandmarks);
      }
    }

    // Les points affichés sont BRUTS (non lissés) : pratique pour comparer
    if (chkSkeleton.checked && lastLandmarks) {
      drawSkeleton(ctx, lastLandmarks);
      if (chkWarp.checked && body) {
        drawControlPoints(ctx);                           // jaune : points du maillage
        if (autoShoulder) shoulderTracker.drawDebug(ctx); // vert : contour réel mesuré
      }
    }

    rafId = requestAnimationFrame(loop);
  }

  return {
    name: "fast",

    // Ouvre la caméra et lance la boucle de rendu dans le canvas outputElement
    async start(videoElement, outputElement) {
      video = videoElement;
      canvas = outputElement;
      ctx = canvas.getContext("2d");

      setStatus("Chargement des modèles…");
      // La segmentation est facultative : si elle échoue, l'essayage marche quand même
      const segPromise = initSegmenter().then(
        () => true,
        (err) => { console.warn("Segmentation indisponible :", err); return false; }
      );
      const [, segOk] = await Promise.all([initPoseDetector(), segPromise]);
      segmenterReady = segOk;
      chkAutoShoulder.disabled = !segOk;
      chkOcclusion.disabled = !segOk;

      setStatus("Ouverture de la caméra…");
      await startCamera(video);
      resizeCanvas(canvas, video);

      fps.frames = 0;
      fps.since = performance.now();
      fpsEl.hidden = false;
      setStatus(
        `Essayage : ${currentGarment?.name ?? "—"}` +
        (segOk ? "" : " (occlusion indisponible sur ce navigateur)")
      );
      loop();
    },

    // Change d'article (fonctionne aussi caméra éteinte : l'image est préchargée)
    async setGarment(g) {
      const token = ++selectToken;
      currentGarment = g;

      // Tout ce qui dépend de l'image est remis à zéro
      garmentImg = null;                 // rien n'est dessiné pendant le chargement
      garmentColor = { r: 0, g: 0, b: 0 };
      lighting.resetFill();
      fillDirty = true;
      resetWarp();                       // rotation des manches, debug du maillage
      // (maillage et couleur dominante : recalculés pour chaque nouvelle image)

      try {
        const img = await loadGarmentImage(g.src);
        if (token !== selectToken) return;
        garmentImg = img;
        garmentColor = getGarmentInfo(img).color;
        if (rafId != null) setStatus(`Essayage : ${g.name}`);
      } catch (err) {
        if (token !== selectToken) return;
        console.error(err);
        setStatus(`Image introuvable pour « ${g.name} » (${g.src}).`);
      }
    },

    // Arrête la boucle, éteint la caméra et remet tout à zéro
    stop() {
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      if (video) stopCamera(video);
      if (ctx) clearCanvas(ctx);
      smoother.reset();
      lastVideoTime = -1;
      lastLandmarks = null;
      body = null;
      resetSegmenter();
      occlusion.reset();
      lighting.reset();
      shoulderTracker.reset();
      resetWarp();
      fillDirty = true;
      shoulderInfoEl.textContent = "";
      frameIndex = 0;
      fpsEl.hidden = true;
      fpsEl.textContent = "– FPS";
    },

    // Image chargée de l'article actif (pour la fenêtre "Ajuster")
    getLoadedImage: () => garmentImg,
    isRunning: () => rafId != null,
  };
}
