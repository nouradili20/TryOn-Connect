// Gère uniquement l'accès à la caméra : ouvrir et fermer.

export async function startCamera(video) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("UNSUPPORTED");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",          // caméra frontale sur mobile
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,                  // on n'a jamais besoin du micro
  });

  video.srcObject = stream;
  await video.play();              // attend que la vidéo démarre vraiment
  return stream;
}

export function stopCamera(video) {
  const stream = video.srcObject;
  if (stream) {
    // Arrêter chaque piste éteint réellement la caméra (le voyant s'éteint)
    stream.getTracks().forEach((track) => track.stop());
  }
  video.srcObject = null;
}