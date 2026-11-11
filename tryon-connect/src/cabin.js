// Cabine d'essayage : galerie, import, suppression, calibration, conservation, export.
// main.js reçoit simplement l'article choisi via onSelect(garment).
import { listGarments, getGarment, addGarment, removeGarment, makeId } from "./catalog.js";
import { createGallery } from "./gallery.js";
import { normalizeFile, processGarment, DEFAULT_TOLERANCE, IMPORT_ADVICE } from "./garmentImport.js";
import { saveGarment, loadGarments, deleteGarment } from "./garmentStore.js";
import { openCalibration } from "./calibration.js";
import { forgetGarmentImage } from "./garmentOverlay.js";
import { DEFAULT_FIT } from "./garments.js";

const $ = (id) => document.getElementById(id);

// Réglages par défaut d'un article importé : identiques à "mon-pull"
const IMPORT_FIT = { ...DEFAULT_FIT, ...(getGarment("mon-pull")?.fit ?? {}) };

export function createCabin({ onSelect, getLoadedImage }) {
  const msgEl = $("gallery-msg");
  let activeId = null;
  let fitSaveTimer = null;

  const say = (text) => { msgEl.textContent = text; };

  const gallery = createGallery({
    container: $("gallery"),
    dropZone: $("cabin"),
    fileInput: $("file-input"),
    onSelect: (id) => select(id),
    onRemove: (id) => remove(id),
    onAdjust: (id) => adjust(id),
    onFiles: (files) => importFiles(files),
  });

  const render = () => gallery.render(listGarments(), activeId);

  // Enregistrement local (jamais bloquant : en cas d'échec, l'article reste
  // utilisable pendant la session)
  async function persist(g) {
    if (g.builtIn) return;
    try {
      await saveGarment({
        id: g.id,
        name: g.name,
        description: g.description ?? "",
        anchors: g.anchors,
        fit: g.fit,
        tolerance: g.tolerance,
        hadAlpha: g.hadAlpha,
        warning: g.warning,
        original: g.original,
        processed: g.processed,
        createdAt: g.createdAt,
      });
    } catch (err) {
      console.warn("Stockage local impossible :", err);
      say("Stockage local indisponible : l'article restera disponible jusqu'au rechargement de la page.");
    }
  }

  function select(id) {
    const g = getGarment(id);
    if (!g) return;
    activeId = id;
    render();
    onSelect(g);
  }

  // Article importé → objet du catalogue
  function makeImported(id, name, original, res, tolerance, extra = {}) {
    return {
      id,
      name,
      src: URL.createObjectURL(res.blob),
      anchors: res.anchors ?? { shoulderLeft: { x: 0, y: 0 }, shoulderRight: { x: 0, y: 0 }, hipY: 0 },
      fit: { ...IMPORT_FIT },
      builtIn: false,
      tolerance,
      hadAlpha: res.hadAlpha,
      warning: res.warning,
      original,
      processed: res.blob,
      createdAt: Date.now(),
      ...extra,
    };
  }

  async function importFiles(files) {
    let lastId = null, warnings = 0, failures = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      say(`Import ${i + 1}/${files.length} : ${file.name}…`);
      try {
        const original = await normalizeFile(file);
        const res = await processGarment(original, DEFAULT_TOLERANCE);
        const name = file.name.replace(/\.[a-z0-9]+$/i, "");
        const g = makeImported(makeId(file.name), name, original, res, DEFAULT_TOLERANCE);
        addGarment(g);
        render();
        await persist(g);
        if (g.warning) warnings++;
        lastId = g.id;
      } catch (err) {
        console.error(err);
        failures++;
      }
    }
    if (lastId) select(lastId);
    const parts = [];
    if (lastId) parts.push(`${files.length - failures} article(s) importé(s).`);
    if (failures) parts.push(`${failures} image(s) illisible(s).`);
    if (warnings) parts.push(`⚠ ${warnings} détourage(s) douteux. ${IMPORT_ADVICE}`);
    say(parts.join(" "));
  }

  async function remove(id) {
    const g = removeGarment(id);
    if (!g) return;
    forgetGarmentImage(g.src);
    URL.revokeObjectURL(g.src);
    try { await deleteGarment(id); } catch (err) { console.warn(err); }
    if (activeId === id) select("mon-pull");
    else render();
    say(`« ${g.name} » supprimé.`);
  }

  async function adjust(id) {
    const g = getGarment(id);
    const img = getLoadedImage();
    if (!g || !img) {
      say("Image pas encore chargée (ou introuvable) : impossible d'ajuster.");
      return;
    }
    const tolNote = g.builtIn
      ? "Article du catalogue : la tolérance du fond ne s'applique qu'aux images importées."
      : "Image déjà transparente : pas de suppression de fond.";
    const canTol = !g.builtIn && !g.hadAlpha;

    const out = await openCalibration(g, {
      canvas: img,
      tolerance: canTol ? g.tolerance ?? DEFAULT_TOLERANCE : null,
      toleranceNote: tolNote,
      reprocess: canTol ? (tol) => processGarment(g.original, tol) : null,
    });
    if (!out) return; // Annuler

    g.name = out.name;
    g.description = out.description;
    g.anchors = out.anchors;
    let imageChanged = false;
    if (out.result) {
      // Nouveau détourage → nouvelle image
      forgetGarmentImage(g.src);
      URL.revokeObjectURL(g.src);
      g.src = URL.createObjectURL(out.result.blob);
      g.processed = out.result.blob;
      g.warning = out.result.warning;
      g.tolerance = out.tolerance;
      imageChanged = true;
    }
    await persist(g);
    render();
    if (imageChanged || activeId === id) onSelect(g); // recharge et réinitialise
    say(
      g.builtIn
        ? "Réglages appliqués pour cette session. « Copier la config » pour les garder dans garments.js."
        : "Réglages appliqués et enregistrés."
    );
  }

  // Bloc JS prêt à coller dans GARMENTS (src/garments.js)
  function configText(g) {
    const a = g.anchors;
    const f = { ...DEFAULT_FIT, ...g.fit };
    const n = (v) => Math.round(v);
    const opt = ["waistY", "hemY", "armpitY", "sleeveAngle"]
      .filter((k) => a[k] != null)
      .map((k) => `\n      ${k}: ${n(a[k])},`)
      .join("");
    const src = g.builtIn ? g.src : `/garments/${g.id}.png`;
    return (
      `  ${JSON.stringify(g.id)}: {\n` +
      `    name: ${JSON.stringify(g.name)},\n` +
      (g.description ? `    description: ${JSON.stringify(g.description)},\n` : "") +
      `    src: ${JSON.stringify(src)},\n` +
      `    anchors: {\n` +
      `      shoulderLeft: { x: ${n(a.shoulderLeft.x)}, y: ${n(a.shoulderLeft.y)} },\n` +
      `      shoulderRight: { x: ${n(a.shoulderRight.x)}, y: ${n(a.shoulderRight.y)} },\n` +
      `      hipY: ${n(a.hipY)},${opt}\n` +
      `    },\n` +
      `    fit: { widthScale: ${f.widthScale.toFixed(2)}, lengthScale: ${f.lengthScale.toFixed(2)}, ` +
      `offsetY: ${f.offsetY.toFixed(2)}, shoulderLift: ${f.shoulderLift.toFixed(2)}, ` +
      `shoulderSpread: ${f.shoulderSpread.toFixed(2)} },\n` +
      `  },\n`
    );
  }

  async function copyConfig() {
    const g = getGarment(activeId);
    if (!g) return;
    const text = configText(g);
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Repli : sélection d'un champ texte temporaire
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.append(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    say(
      g.builtIn
        ? "Config copiée : remplace l'entrée correspondante dans src/garments.js."
        : `Config copiée. Colle-la dans GARMENTS (src/garments.js) et place le PNG détouré dans public/garments/${g.id}.png.`
    );
  }

  function downloadPng() {
    const g = getGarment(activeId);
    if (!g) return;
    const a = document.createElement("a");
    a.href = g.src;
    a.download = g.builtIn ? g.src.split("/").pop() : `${g.id}.png`;
    document.body.append(a);
    a.click();
    a.remove();
  }

  // Les curseurs "fit" ont bougé : on enregistre (avec un petit délai)
  function fitChanged() {
    const g = getGarment(activeId);
    if (!g || g.builtIn) return;
    clearTimeout(fitSaveTimer);
    fitSaveTimer = setTimeout(() => persist(g), 500);
  }

  $("btn-copy").addEventListener("click", copyConfig);
  $("btn-download").addEventListener("click", downloadPng);

  // Démarrage : catalogue tout de suite, articles enregistrés ensuite
  async function init(defaultId) {
    select(defaultId);
    try {
      const records = await loadGarments();
      for (const r of records) {
        if (getGarment(r.id)) continue;
        addGarment({
          ...r,
          fit: { ...IMPORT_FIT, ...r.fit },
          src: URL.createObjectURL(r.processed),
          builtIn: false,
        });
      }
      render();
    } catch (err) {
      console.warn("Lecture du stockage local impossible :", err);
      say("Stockage local indisponible : les articles importés ne seront pas conservés.");
    }
  }

  return { init, fitChanged, getActive: () => getGarment(activeId) };
}
