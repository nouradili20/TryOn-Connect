// Point d'entrée : interface, cabin d'essayage et choix du moteur.
//  - Mode Rapide (par défaut)  : src/engines/fastEngine.js, tout reste sur l'appareil.
//  - Mode Réaliste IA          : src/engines/aiEngine.js, vidéo traitée par Decart.
// Les deux moteurs ont la même interface : start(video, sortie), setGarment(article), stop().
import "./style.css";
import { DEFAULT_FIT } from "./garments.js";
import { createCabin } from "./cabin.js";
import { createFastEngine } from "./engines/fastEngine.js";
import {
  COST_PER_SECOND, DEFAULT_MAX_SECONDS, EXTEND_SECONDS, MODEL_ID,
} from "./engines/aiConfig.js";
// Le moteur IA (et le SDK Decart) n'est chargé qu'au premier passage en mode IA

// Article sélectionné au démarrage (les autres se choisissent dans la galerie)
const DEFAULT_GARMENT_ID = "mon-pull";
const CONSENT_KEY = "tryon-ai-consent-v1";

const $ = (id) => document.getElementById(id);

const video = $("video");
const canvas = $("canvas");
const aiOutput = $("ai-output");
const btnStart = $("btn-start");
const btnStop = $("btn-stop");
const statusEl = $("status");

const rngWidth = $("rng-width");
const rngLength = $("rng-length");
const rngOffset = $("rng-offset");
const rngSmooth = $("rng-smooth");
const rngLift = $("rng-lift");
const rngSpread = $("rng-spread");
const rngShade = $("rng-shade");
const rngFeather = $("rng-feather");
const rngHide = $("rng-hide");
const fitOutput = $("fit-output");

let currentGarment = null; // choisi par la cabine d'essayage

function setStatus(text) {
  statusEl.textContent = text;
}

function errorMessage(err) {
  switch (err?.name) {
    case "NotAllowedError": return "Accès à la caméra refusé. Autorise-le dans la barre d'adresse.";
    case "NotFoundError": return "Aucune caméra détectée.";
    case "NotReadableError": return "La caméra est utilisée par une autre application.";
    default:
      if (err?.message === "UNSUPPORTED") return "Ton navigateur ne permet pas l'accès à la caméra.";
      return "Erreur : " + (err?.message ?? err);
  }
}

// ---------- Panneau d'ajustement (mode rapide) ----------

function updateTuningLabels() {
  const f = currentGarment.fit;
  $("val-width").textContent = f.widthScale.toFixed(2);
  $("val-length").textContent = f.lengthScale.toFixed(2);
  $("val-offset").textContent = f.offsetY.toFixed(2);
  $("val-smooth").textContent = Number(rngSmooth.value).toFixed(2);
  $("val-lift").textContent = f.shoulderLift.toFixed(2);
  $("val-spread").textContent = f.shoulderSpread.toFixed(2);

  fitOutput.textContent =
    `fit: { widthScale: ${f.widthScale.toFixed(2)}, ` +
    `lengthScale: ${f.lengthScale.toFixed(2)}, ` +
    `offsetY: ${f.offsetY.toFixed(2)}, ` +
    `shoulderLift: ${f.shoulderLift.toFixed(2)}, ` +
    `shoulderSpread: ${f.shoulderSpread.toFixed(2)} },`;
}

// Place les curseurs sur les valeurs du vêtement actuel
// (les vêtements sans shoulderLift / shoulderSpread prennent les valeurs par défaut)
function syncTuningFromGarment() {
  currentGarment.fit = { ...DEFAULT_FIT, ...currentGarment.fit };
  rngWidth.value = currentGarment.fit.widthScale;
  rngLength.value = currentGarment.fit.lengthScale;
  rngOffset.value = currentGarment.fit.offsetY;
  rngLift.value = currentGarment.fit.shoulderLift;
  rngSpread.value = currentGarment.fit.shoulderSpread;
  updateTuningLabels();
}

// Quand un curseur bouge, on modifie le vêtement en direct
function onTuningInput() {
  currentGarment.fit = {
    widthScale: Number(rngWidth.value),
    lengthScale: Number(rngLength.value),
    offsetY: Number(rngOffset.value),
    shoulderLift: Number(rngLift.value),
    shoulderSpread: Number(rngSpread.value),
  };
  updateTuningLabels();
  cabin.fitChanged(); // articles importés : réglages enregistrés
}

[rngWidth, rngLength, rngOffset, rngSmooth, rngLift, rngSpread].forEach((el) =>
  el.addEventListener("input", onTuningInput)
);

// Curseurs d'éclairage (réglages d'affichage, pas du vêtement)
function updateLightingLabels() {
  $("val-shade").textContent = Number(rngShade.value).toFixed(2);
  $("val-feather").textContent = Number(rngFeather.value).toFixed(2);
  $("val-hide").textContent = Number(rngHide.value).toFixed(2);
}
[rngShade, rngFeather, rngHide].forEach((el) =>
  el.addEventListener("input", updateLightingLabels)
);
updateLightingLabels();

// ---------- Panneau du Mode Réaliste IA ----------

const AI_STATE_LABELS = {
  idle: "Inactif",
  connecting: "Connexion…",
  active: "Actif",
  reconnecting: "Reconnexion…",
  error: "Erreur",
  quota: "Quota dépassé",
  token: "Jeton invalide",
  ended: "Terminé",
};
const aiMaxInput = $("ai-max");
const btnExtend = $("btn-extend");
const btnFallback = $("btn-fallback");
const money = (v) => v.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " $";

$("ai-rate").textContent =
  `Modèle ${MODEL_ID} · ${money(COST_PER_SECOND)}/s, soit ${money(COST_PER_SECOND * 60)} par minute`;
btnExtend.textContent = `Prolonger (+${EXTEND_SECONDS} s)`;

// Durée max choisie (mémorisée sur cet appareil, avec repli si le stockage est bloqué)
try {
  const saved = Number(localStorage.getItem("tryon-ai-max"));
  aiMaxInput.value = saved >= 10 ? saved : DEFAULT_MAX_SECONDS;
} catch { aiMaxInput.value = DEFAULT_MAX_SECONDS; }
aiMaxInput.addEventListener("change", () => {
  const v = Math.min(600, Math.max(10, Number(aiMaxInput.value) || DEFAULT_MAX_SECONDS));
  aiMaxInput.value = v;
  try { localStorage.setItem("tryon-ai-max", String(v)); } catch { /* facultatif */ }
});

function onAiUpdate({ state, message, remaining, consumed, cost }) {
  const stateEl = $("ai-state");
  stateEl.dataset.state = state;
  stateEl.textContent = AI_STATE_LABELS[state] ?? state;
  $("ai-message").textContent = message;
  $("ai-remaining").textContent = remaining == null ? "—" : `${Math.ceil(remaining)} s`;
  $("ai-consumed").textContent = `${consumed.toFixed(0)} s`;
  $("ai-cost").textContent = money(cost);
  btnExtend.disabled = !(state === "active" || state === "reconnecting");

  const failed = state === "error" || state === "quota" || state === "token";
  btnFallback.hidden = !failed;

  // Fin de session (automatique ou erreur) : la caméra est déjà éteinte par le moteur
  if ((failed || state === "ended") && mode === "ai") {
    running = false;
    btnStop.disabled = true;
    btnStart.disabled = false;
    setStatus(message || "Session IA terminée.");
  }
}

// ---------- Moteurs ----------

const fastEngine = createFastEngine({ setStatus });
let aiEngine = null; // créé à la demande

async function getAiEngine() {
  if (!aiEngine) {
    const { createAiEngine } = await import("./engines/aiEngine.js");
    aiEngine ??= createAiEngine({
      onUpdate: onAiUpdate,
      getMaxSeconds: () => Number(aiMaxInput.value) || DEFAULT_MAX_SECONDS,
    });
  }
  return aiEngine;
}

let mode = "fast";
let running = false;
const engine = async () => (mode === "ai" ? getAiEngine() : fastEngine);

// Affiche la bonne sortie et masque les réglages propres au mode rapide
function applyModeUi() {
  document.body.classList.toggle("mode-ai", mode === "ai");
  canvas.hidden = mode === "ai";
  aiOutput.hidden = mode !== "ai";
  $("ai-panel").hidden = mode !== "ai";
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
}

async function startEngine() {
  btnStart.disabled = true;
  try {
    const out = mode === "ai" ? aiOutput : canvas;
    running = true;
    const eng = await engine();
    if (mode === "ai" && currentGarment) eng.setGarment(currentGarment);
    await eng.start(video, out);
    btnStop.disabled = false;
    if (mode === "ai") setStatus(`Essayage IA : ${currentGarment?.name ?? "—"}`);
  } catch (err) {
    running = false;
    console.error(err);
    btnStart.disabled = false;
    btnStop.disabled = true;
    // En mode IA, le panneau affiche déjà l'erreur et propose le mode rapide
    if (mode !== "ai") setStatus(errorMessage(err));
    else setStatus("Connexion IA impossible. Tu peux passer en mode rapide.");
  }
}

// "Arrêter" : coupe le moteur actif (connexion Decart comprise) ET la caméra
function stopEngine() {
  fastEngine.stop();
  aiEngine?.stop();
  running = false;
  btnStop.disabled = true;
  btnStart.disabled = false;
  setStatus("Caméra arrêtée.");
}

// Consentement : demandé avant la première connexion au mode IA
function hasConsent() {
  try { return localStorage.getItem(CONSENT_KEY) === "yes"; } catch { return false; }
}
let sessionConsent = false; // si le stockage est bloqué, valable pour cette visite

function askConsent() {
  if (sessionConsent || hasConsent()) return Promise.resolve(true);
  const dialog = $("consent");
  return new Promise((resolve) => {
    const done = (ok) => {
      $("consent-accept").removeEventListener("click", onAccept);
      $("consent-decline").removeEventListener("click", onDecline);
      dialog.removeEventListener("cancel", onCancel);
      if (dialog.open) dialog.close();
      resolve(ok);
    };
    const onAccept = () => {
      sessionConsent = true;
      try { localStorage.setItem(CONSENT_KEY, "yes"); } catch { /* facultatif */ }
      done(true);
    };
    const onDecline = () => done(false);
    const onCancel = (e) => { e.preventDefault(); done(false); };
    $("consent-accept").addEventListener("click", onAccept);
    $("consent-decline").addEventListener("click", onDecline);
    dialog.addEventListener("cancel", onCancel);
    dialog.showModal();
  });
}

async function switchMode(next) {
  if (next === mode) return;
  if (next === "ai" && !(await askConsent())) {
    applyModeUi(); // on reste en mode rapide
    setStatus("Mode rapide conservé : rien n'est envoyé.");
    return;
  }
  const wasRunning = running;
  if (wasRunning) stopEngine();
  mode = next;
  applyModeUi();
  if (currentGarment) (await engine()).setGarment(currentGarment);
  setStatus(mode === "ai" ? "Mode Réaliste IA : clique sur « Démarrer la caméra »." : "Mode rapide : tout reste sur ton appareil.");
  if (wasRunning) startEngine();
}

for (const r of document.querySelectorAll('input[name="mode"]')) {
  r.addEventListener("change", () => { if (r.checked) switchMode(r.value); });
}
btnFallback.addEventListener("click", () => switchMode("fast"));
btnExtend.addEventListener("click", () => aiEngine?.extend());

btnStart.addEventListener("click", startEngine);
btnStop.addEventListener("click", stopEngine);

// ---------- Changement d'article (cabine d'essayage) ----------

function selectGarment(g) {
  currentGarment = g;
  syncTuningFromGarment();
  // Le moteur rapide précharge toujours l'image (utile aussi pour "Ajuster")
  fastEngine.setGarment(g);
  if (mode === "ai") aiEngine?.setGarment(g); // envoyé à Decart si la session est ouverte
  if (!running) setStatus(`Article choisi : ${g.name}`);
  else if (mode === "ai") setStatus(`Essayage IA : ${g.name}`);
}

const cabin = createCabin({
  onSelect: selectGarment,
  getLoadedImage: () => fastEngine.getLoadedImage(),
});

applyModeUi();
cabin.init(DEFAULT_GARMENT_ID);
