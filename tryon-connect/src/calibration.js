// Fenêtre de calibration d'un article : repères déplaçables (souris et tactile),
// nom, tolérance du fond (recalcul en direct), recalcul des ancres.
import { computeAnchorsFromCanvas, IMPORT_ADVICE } from "./garmentImport.js";

const $ = (id) => document.getElementById(id);
const MAX_W = 520;

// Ouvre la fenêtre. Renvoie une promesse :
//   { name, description, anchors, result, tolerance }  si "Appliquer"
//   null                                  si "Annuler" (ou Échap)
// options :
//   canvas     : image actuelle du vêtement (canvas ou image chargée)
//   tolerance  : valeur de départ, ou null si la tolérance ne s'applique pas
//   toleranceNote : texte expliquant pourquoi la tolérance est désactivée
//   reprocess  : (tol) => Promise<{ canvas, anchors, warning }>  (recalcul du fond)
export function openCalibration(garment, options) {
  const dialog = $("calib");
  const stage = $("calib-stage");
  const cvs = $("calib-canvas");
  const hL = $("calib-left"), hR = $("calib-right"), hip = $("calib-hip");
  const nameInput = $("calib-name");
  const tol = $("calib-tol"), tolVal = $("calib-tol-val");
  const msg = $("calib-msg");
  const btnRecompute = $("calib-recompute"), btnApply = $("calib-apply"), btnCancel = $("calib-cancel");

  let source = options.canvas;          // image affichée (peut changer avec la tolérance)
  let result = null;                    // nouveau détourage, si recalculé
  let anchors = structuredClone(garment.anchors);
  let scale = 1;
  let reprocessTimer = null, reprocessToken = 0;

  nameInput.value = garment.name;
  const descInput = $("calib-desc");
  descInput.value = garment.description ?? "";
  const tolOn = options.tolerance != null && typeof options.reprocess === "function";
  tol.disabled = !tolOn;
  tol.value = tolOn ? options.tolerance : 0;
  tolVal.textContent = tolOn ? String(options.tolerance) : "—";
  msg.textContent = tolOn ? (garment.warning ? `⚠ ${garment.warning} ${IMPORT_ADVICE}` : "") : (options.toleranceNote ?? "");

  // Les ancres doivent rester à l'intérieur de l'image
  const sw = () => source.naturalWidth || source.width;
  const sh = () => source.naturalHeight || source.height;
  const clampAnchors = () => {
    for (const p of [anchors.shoulderLeft, anchors.shoulderRight]) {
      p.x = Math.min(sw(), Math.max(0, p.x));
      p.y = Math.min(sh(), Math.max(0, p.y));
    }
    anchors.hipY = Math.min(sh(), Math.max(0, anchors.hipY));
  };

  // --- Dessin : image + lignes guides ; repères = éléments HTML ---
  function layout() {
    const maxW = Math.min(MAX_W, window.innerWidth - 64);
    const maxH = Math.max(200, window.innerHeight * 0.55);
    scale = Math.min(maxW / sw(), maxH / sh());
    cvs.width = Math.round(sw() * scale);
    cvs.height = Math.round(sh() * scale);
    stage.style.width = cvs.width + "px";
    stage.style.height = cvs.height + "px";
    redraw();
  }

  function redraw() {
    clampAnchors();
    const ctx = cvs.getContext("2d");
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(source, 0, 0, cvs.width, cvs.height);
    // Ligne des épaules
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#22d3ee";
    ctx.beginPath();
    ctx.moveTo(anchors.shoulderLeft.x * scale, anchors.shoulderLeft.y * scale);
    ctx.lineTo(anchors.shoulderRight.x * scale, anchors.shoulderRight.y * scale);
    ctx.stroke();
    ctx.restore();

    const place = (el, x, y) => { el.style.left = `${x}px`; el.style.top = `${y}px`; };
    place(hL, anchors.shoulderLeft.x * scale, anchors.shoulderLeft.y * scale);
    place(hR, anchors.shoulderRight.x * scale, anchors.shoulderRight.y * scale);
    hip.style.top = `${anchors.hipY * scale}px`;
  }

  // --- Glisser les repères (pointer events : souris, stylet et doigt) ---
  function draggable(el, onMove) {
    const down = (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };
    const move = (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const r = stage.getBoundingClientRect();
      onMove((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
      redraw();
    };
    const up = (e) => {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      el.classList.remove("dragging");
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }

  const cleanups = [
    draggable(hL, (x, y) => { anchors.shoulderLeft.x = Math.round(x); anchors.shoulderLeft.y = Math.round(y); }),
    draggable(hR, (x, y) => { anchors.shoulderRight.x = Math.round(x); anchors.shoulderRight.y = Math.round(y); }),
    draggable(hip, (_x, y) => { anchors.hipY = Math.round(y); }), // vertical uniquement
  ];

  // --- Tolérance : recalcul du fond en direct (avec un petit délai) ---
  const onTol = () => {
    tolVal.textContent = tol.value;
    clearTimeout(reprocessTimer);
    reprocessTimer = setTimeout(async () => {
      const token = ++reprocessToken;
      msg.textContent = "Recalcul du fond…";
      try {
        const r = await options.reprocess(Number(tol.value));
        if (token !== reprocessToken) return; // une valeur plus récente est en cours
        result = r;
        source = r.canvas;
        // Le recadrage a changé : on repart des ancres automatiques
        if (r.anchors) anchors = structuredClone(r.anchors);
        msg.textContent = r.warning ? `⚠ ${r.warning} ${IMPORT_ADVICE}` : "Fond recalculé, ancres recalculées.";
        layout();
      } catch (err) {
        console.error(err);
        msg.textContent = "Recalcul impossible : " + err.message;
      }
    }, 200);
  };
  tol.addEventListener("input", onTol);

  const onRecompute = () => {
    try {
      let c = source;
      if (!(c instanceof HTMLCanvasElement)) {
        // Image chargée → copie dans un canvas pour lire les pixels
        c = document.createElement("canvas");
        c.width = sw();
        c.height = sh();
        c.getContext("2d").drawImage(source, 0, 0);
      }
      const a = computeAnchorsFromCanvas(c);
      if (a) {
        anchors = { ...anchors, ...structuredClone(a) };
        msg.textContent = "Ancres recalculées automatiquement.";
        redraw();
      }
    } catch (err) {
      msg.textContent = "Recalcul impossible : " + err.message;
    }
  };
  btnRecompute.addEventListener("click", onRecompute);

  const onResize = () => layout();
  window.addEventListener("resize", onResize);

  return new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(reprocessTimer);
      reprocessToken++;
      cleanups.forEach((f) => f());
      tol.removeEventListener("input", onTol);
      btnRecompute.removeEventListener("click", onRecompute);
      btnApply.removeEventListener("click", onApply);
      btnCancel.removeEventListener("click", onCancel);
      dialog.removeEventListener("cancel", onEsc);
      window.removeEventListener("resize", onResize);
      if (dialog.open) dialog.close();
      resolve(value);
    };
    const onApply = () =>
      finish({
        name: nameInput.value.trim() || garment.name,
        description: descInput.value.trim(),
        anchors: structuredClone(anchors),
        result,
        tolerance: tolOn ? Number(tol.value) : null,
      });
    const onCancel = () => finish(null);
    const onEsc = (e) => { e.preventDefault(); finish(null); };

    btnApply.addEventListener("click", onApply);
    btnCancel.addEventListener("click", onCancel);
    dialog.addEventListener("cancel", onEsc);

    dialog.showModal();
    layout();
  });
}
