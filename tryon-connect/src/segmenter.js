// Segmentation de la personne (cheveux, peau, vêtements…) avec MediaPipe.
// Tout reste dans le navigateur : l'image ne quitte jamais l'ordinateur.
import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

// Catégories du modèle selfie_multiclass_256x256
export const CATEGORY = {
  BACKGROUND: 0,
  HAIR: 1,
  BODY_SKIN: 2,
  FACE_SKIN: 3,
  CLOTHES: 4,
  OTHERS: 5,
};

// On segmente une version réduite de la vidéo : beaucoup plus rapide,
// et le masque est ensuite agrandi (ce qui adoucit déjà les bords).
const SEG_WIDTH = 320;

let segmenter = null;

// Petit canvas où l'on copie la vidéo réduite avant de la segmenter
const inputCanvas = document.createElement("canvas");
const inputCtx = inputCanvas.getContext("2d", { willReadFrequently: false });

// Dernier masque reçu : un octet (= catégorie) par pixel, à la taille réduite
let lastMask = null; // { data: Uint8Array, width, height }
let lastTimestamp = -1;

function buildOptions(delegate) {
  return {
    baseOptions: {
      modelAssetPath: "/models/selfie_multiclass_256x256.tflite",
      delegate, // "GPU" (rapide) ou "CPU" (secours)
    },
    runningMode: "VIDEO",
    outputCategoryMask: true,      // une catégorie par pixel
    outputConfidenceMasks: false,  // inutile ici : économise de la mémoire
  };
}

export async function initSegmenter() {
  if (segmenter) return segmenter; // déjà chargé

  const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");

  try {
    segmenter = await ImageSegmenter.createFromOptions(vision, buildOptions("GPU"));
  } catch (err) {
    console.warn("Segmentation : GPU indisponible, passage en CPU :", err);
    segmenter = await ImageSegmenter.createFromOptions(vision, buildOptions("CPU"));
  }
  return segmenter;
}

// Segmente l'image vidéo actuelle et mémorise le masque.
export function segment(video, timestampMs) {
  if (!segmenter || !video.videoWidth) return lastMask;

  // MediaPipe exige des horodatages strictement croissants
  if (timestampMs <= lastTimestamp) timestampMs = lastTimestamp + 1;
  lastTimestamp = timestampMs;

  // Vidéo réduite (même proportions)
  const w = SEG_WIDTH;
  const h = Math.round((video.videoHeight / video.videoWidth) * SEG_WIDTH);
  if (inputCanvas.width !== w || inputCanvas.height !== h) {
    inputCanvas.width = w;
    inputCanvas.height = h;
  }
  inputCtx.drawImage(video, 0, 0, w, h);

  // Version "callback" : le masque n'est valable QUE dans cette fonction,
  // MediaPipe le libère (mémoire GPU comprise) juste après. On en copie donc
  // les octets dans notre propre tableau, réutilisé d'une image à l'autre.
  segmenter.segmentForVideo(inputCanvas, timestampMs, (result) => {
    const mask = result.categoryMask;
    if (!mask) return;
    const src = mask.getAsUint8Array();
    if (!lastMask || lastMask.data.length !== src.length) {
      lastMask = { data: new Uint8Array(src.length), width: mask.width, height: mask.height };
    }
    lastMask.data.set(src);
    lastMask.width = mask.width;
    lastMask.height = mask.height;
  });

  return lastMask;
}

export function getLastMask() {
  return lastMask;
}

// Oublie le dernier masque (bouton "Arrêter")
export function resetSegmenter() {
  lastMask = null;
  lastTimestamp = -1;
}
