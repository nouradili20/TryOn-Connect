// MODE RÉALISTE IA : try-on par l'API temps réel de Decart (modèle Lucy VTON).
// La vidéo de la caméra est envoyée à Decart (WebRTC) et on affiche le flux
// transformé qu'il renvoie. Rien n'est enregistré par ce module.
//
// Interface commune aux moteurs : start(videoElement, outputElement), setGarment(garment), stop().
// La clé API n'est JAMAIS dans le navigateur : on demande un jeton temporaire
// à notre petit serveur (/api/tokens, voir server/index.js).
import { createDecartClient, models } from "@decartai/sdk";
import { initPoseDetector, detectPose } from "../poseDetector.js";
import {
  MODEL_ID, COST_PER_SECOND, EXTEND_SECONDS, NO_PERSON_TIMEOUT_MS, ENHANCE_PROMPT,
} from "./aiConfig.js";

const PRESENCE_CHECK_MS = 500; // vérification de présence toutes les 0,5 s
const MIN_IMAGE_SIDE = 512;    // taille mini conseillée pour l'image du vêtement

// Description envoyée au modèle (motif conseillé par le guide VTON : "Substitute …")
export function buildPrompt(garment) {
  const desc = (garment.description || garment.name || "the garment").trim();
  return `Substitute the current top with ${desc}`;
}

// Image du vêtement prête à envoyer : fond blanc uni (la doc conseille un fond
// propre et uni plutôt que la transparence) et au moins 512 px de côté.
async function garmentBlob(garment) {
  const src = garment.processed instanceof Blob
    ? garment.processed
    : await (await fetch(garment.src)).blob();
  const bmp = await createImageBitmap(src);
  const k = Math.max(1, MIN_IMAGE_SIDE / Math.min(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return new Promise((resolve, reject) =>
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("Image du vêtement illisible"))), "image/png")
  );
}

// Demande un jeton temporaire à notre serveur. Le message d'erreur reste
// générique : la clé API n'apparaît jamais côté navigateur.
async function fetchToken() {
  let res;
  try {
    res = await fetch("/api/tokens", { method: "POST" });
  } catch {
    throw Object.assign(new Error("Serveur de jetons injoignable (lance « npm run dev:all »)."), { code: "TOKEN_SERVER_DOWN" });
  }
  let body = null;
  try { body = await res.json(); } catch { /* réponse non JSON */ }
  if (!res.ok || !body?.apiKey) {
    const code = body?.code || (res.status === 429 ? "RATE_LIMITED" : "TOKEN_CREATE_ERROR");
    throw Object.assign(new Error(body?.error || `Jeton refusé (HTTP ${res.status}).`), { code });
  }
  return body.apiKey;
}

// Traduit une erreur (SDK ou serveur) en état d'interface + message
function describeError(err) {
  const code = err?.code || "";
  const map = {
    NO_API_KEY: ["token", "Clé API absente côté serveur : crée le fichier .env (voir .env.example)."],
    TOKEN_SERVER_DOWN: ["error", "Serveur de jetons injoignable : lance « npm run dev:all »."],
    TOKEN_CREATE_ERROR: ["token", "Impossible d'obtenir un jeton : vérifie DECART_API_KEY dans .env."],
    INVALID_API_KEY: ["token", "Jeton ou clé API invalide."],
    TOKEN_INVALID: ["token", "Jeton invalide."],
    TOKEN_EXPIRED: ["token", "Jeton expiré : réessaie."],
    RATE_LIMITED: ["quota", "Trop de demandes de jetons : patiente une minute."],
    MODEL_NOT_FOUND: ["error", `Modèle introuvable (${MODEL_ID}).`],
  };
  if (map[code]) return { state: map[code][0], message: map[code][1] };
  if (code.startsWith("WEBRTC")) return { state: "error", message: "Connexion temps réel impossible (réseau ou pare-feu)." };
  if (err?.name === "NotAllowedError") return { state: "error", message: "Accès à la caméra refusé." };
  if (err?.name === "NotFoundError") return { state: "error", message: "Aucune caméra détectée." };
  return { state: "error", message: err?.message || "Erreur inconnue." };
}

// Fin de session décidée par le serveur
function describeSessionEnd(reason) {
  switch (reason) {
    case "insufficient_credits": return { state: "quota", message: "Crédits Decart épuisés (quota dépassé)." };
    case "session_limit": return { state: "quota", message: "Limite de sessions simultanées atteinte." };
    case "moderation_violation": return { state: "error", message: "Session interrompue par la modération de Decart." };
    case "policy_violation": return { state: "error", message: "Connexion refusée par Decart (politique d'accès)." };
    default: return { state: "ended", message: `Session terminée par le serveur (${reason}).` };
  }
}

// onUpdate({ state, message, remaining, consumed, cost }) : pour l'interface.
//   state : "idle" | "connecting" | "active" | "reconnecting" | "error" | "quota" | "token" | "ended"
// getMaxSeconds() : durée max choisie dans l'interface
export function createAiEngine({ onUpdate, getMaxSeconds }) {
  let client = null, rt = null, stream = null;
  let video = null, output = null;
  let garment = null;
  let state = "idle", message = "";
  let runId = 0;                 // invalide un démarrage en cours si on arrête entre-temps
  let deadline = 0, generatingSince = 0, billedSeconds = 0;
  let timerId = null, presenceId = null, lastPersonAt = 0;

  // Secondes facturées : celles annoncées par Decart, sinon estimation locale
  const consumed = () => {
    if (billedSeconds) return billedSeconds;
    return generatingSince ? (performance.now() - generatingSince) / 1000 : 0;
  };

  function emit(newState, newMessage) {
    if (newState) state = newState;
    if (newMessage !== undefined) message = newMessage;
    const remaining = deadline ? Math.max(0, (deadline - performance.now()) / 1000) : null;
    const c = consumed();
    onUpdate({ state, message, remaining, consumed: c, cost: c * COST_PER_SECOND });
  }

  // Coupe tout : connexion Decart, caméra, minuteries
  function teardown() {
    // Fige le temps consommé (sinon l'estimation locale continuerait d'avancer)
    billedSeconds = consumed();
    generatingSince = 0;
    clearInterval(timerId);
    clearInterval(presenceId);
    timerId = presenceId = null;
    document.removeEventListener("visibilitychange", onVisibility);
    try { rt?.disconnect(); } catch (err) { console.warn(err); }
    rt = null;
    client = null;
    stream?.getTracks().forEach((t) => t.stop()); // la caméra s'éteint vraiment
    stream = null;
    if (video) video.srcObject = null;
    if (output) output.srcObject = null;
  }

  // Arrêt automatique (durée max, onglet masqué, personne absente…)
  function autoStop(reason) {
    if (!rt && !stream) return;
    runId++;
    teardown();
    emit("ended", reason);
    deadline = 0;
  }

  function onVisibility() {
    if (document.hidden) autoStop("Session coupée : onglet masqué (pour ne pas consommer de crédits).");
  }

  // Présence : MediaPipe sur la vidéo LOCALE (rien d'envoyé pour ça)
  async function startPresenceCheck(id) {
    try { await initPoseDetector(); } catch { return; } // facultatif
    if (id !== runId) return;
    lastPersonAt = performance.now();
    presenceId = setInterval(() => {
      if (!video?.videoWidth) return;
      const lm = detectPose(video, performance.now());
      if (lm) lastPersonAt = performance.now();
      else if (performance.now() - lastPersonAt > NO_PERSON_TIMEOUT_MS) {
        autoStop("Session coupée : personne devant la caméra depuis 15 s.");
      }
    }, PRESENCE_CHECK_MS);
  }

  async function sendGarment() {
    if (!rt || !garment) return;
    try {
      const image = await garmentBlob(garment);
      if (!rt) return;
      // set() remplace TOUT l'état : on renvoie image + prompt + enhance ensemble
      await rt.set({ image, prompt: buildPrompt(garment), enhance: ENHANCE_PROMPT });
    } catch (err) {
      console.error(err);
      emit(undefined, "Envoi du vêtement impossible : " + (err.message || err.code));
    }
  }

  return {
    name: "ai",

    async start(videoElement, outputElement) {
      const id = ++runId;
      video = videoElement;
      output = outputElement;
      billedSeconds = 0;
      generatingSince = 0;
      deadline = 0;

      try {
        emit("connecting", "Ouverture de la caméra…");
        const model = models.realtime(MODEL_ID);
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: model.width },   // 1280 × 720 pour ce modèle
            height: { ideal: model.height },
            frameRate: model.fps,            // { ideal: 30, max: 30 }
          },
          audio: false,
        });
        if (id !== runId) { stream.getTracks().forEach((t) => t.stop()); stream = null; return; }
        video.srcObject = stream;
        await video.play();

        emit("connecting", "Connexion à Decart…");
        const initialGarment = garment;
        const initialImage = initialGarment ? await garmentBlob(initialGarment) : null;
        if (id !== runId) return;

        client = createDecartClient({
          apiKeyProvider: fetchToken, // nouveau jeton à chaque (re)connexion
          telemetry: false,           // pas de télémétrie envoyée
        });

        const conn = await client.realtime.connect(stream, {
          model,
          mirror: true, // l'image est retournée AVANT l'envoi : effet miroir, logos lisibles
          onRemoteStream: (remote) => {
            output.srcObject = remote;
            output.play().catch(() => {});
          },
          initialState: initialImage
            ? { image: initialImage, prompt: { text: buildPrompt(initialGarment), enhance: ENHANCE_PROMPT } }
            : undefined,
        });
        if (id !== runId) { conn.disconnect(); return; } // "Arrêter" cliqué pendant la connexion
        rt = conn;
        // Article changé pendant la connexion : on envoie le nouveau
        if (garment && garment !== initialGarment) sendGarment();

        rt.on("connectionChange", (s) => {
          if (s === "generating" && !generatingSince) generatingSince = performance.now();
          if (s === "connected" || s === "generating") emit("active", "Session IA active.");
          else if (s === "reconnecting" || s === "connecting") emit("reconnecting", "Reconnexion…");
          else if (s === "disconnected" && state !== "quota" && state !== "token") {
            emit("ended", message && state === "error" ? message : "Déconnecté.");
          }
        });
        rt.on("error", (err) => {
          const d = describeError(err);
          emit(d.state, d.message);
        });
        rt.on("generationTick", ({ seconds }) => {
          if (typeof seconds === "number") billedSeconds = Math.max(billedSeconds, seconds);
        });
        rt.on("sessionEnded", ({ reason }) => {
          const d = describeSessionEnd(reason);
          runId++;
          teardown();
          emit(d.state, d.message);
          deadline = 0;
        });

        // Durée maximale + compte à rebours
        deadline = performance.now() + getMaxSeconds() * 1000;
        timerId = setInterval(() => {
          if (performance.now() >= deadline) autoStop("Durée maximale atteinte : session coupée.");
          else emit();
        }, 250);
        document.addEventListener("visibilitychange", onVisibility);
        startPresenceCheck(id);
        emit("active", "Session IA active.");
      } catch (err) {
        if (id !== runId) return;
        console.error("Mode IA :", err?.code ?? err?.name, err?.message);
        teardown();
        const d = describeError(err);
        deadline = 0;
        emit(d.state, d.message);
        throw err; // main.js propose alors le mode rapide
      }
    },

    // Change d'article : envoyé tout de suite si la session est ouverte,
    // sinon il servira d'état initial à la prochaine connexion
    async setGarment(g) {
      garment = g;
      await sendGarment();
    },

    // "Prolonger" : ajoute du temps à la session en cours
    extend(seconds = EXTEND_SECONDS) {
      if (!rt || !deadline) return;
      deadline += seconds * 1000;
      emit();
    },

    stop() {
      runId++;
      teardown();
      deadline = 0;
      emit("idle", "");
    },

    isRunning: () => rt != null || stream != null,
  };
}
