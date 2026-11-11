// Encapsule MediaPipe : le reste du projet ne sait pas comment la détection fonctionne.
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";

let landmarker = null;

function buildOptions(delegate) {
  return {
    baseOptions: {
      modelAssetPath: "/models/pose_landmarker_lite.task",
      delegate, // "GPU" (rapide) ou "CPU" (secours)
    },
    runningMode: "VIDEO",          // optimisé pour un flux continu
    numPoses: 1,                   // une seule personne
    minPoseDetectionConfidence: 0.5,
    minPosePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  };
}

export async function initPoseDetector() {
  if (landmarker) return landmarker; // déjà chargé : on ne recharge pas

  const vision = await FilesetResolver.forVisionTasks("/mediapipe/wasm");

  try {
    landmarker = await PoseLandmarker.createFromOptions(vision, buildOptions("GPU"));
  } catch (err) {
    console.warn("GPU indisponible, passage en CPU :", err);
    landmarker = await PoseLandmarker.createFromOptions(vision, buildOptions("CPU"));
  }
  return landmarker;
}

// Renvoie les 33 points du corps détecté, ou null si personne n'est visible.
export function detectPose(video, timestampMs) {
  if (!landmarker) return null;
  const result = landmarker.detectForVideo(video, timestampMs);
  return result.landmarks?.[0] ?? null;
}