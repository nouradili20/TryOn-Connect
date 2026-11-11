// Dessin de base sur le canvas : vidéo et squelette de debug.

export const POINTS = {
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
};

const CONNECTIONS = [
  [11, 12],
  [11, 13], [13, 15],
  [12, 14], [14, 16],
  [11, 23], [12, 24],
  [23, 24],
];

const MIN_VISIBILITY = 0.5;

export function resizeCanvas(canvas, video) {
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
}

export function drawVideo(ctx, video) {
  ctx.drawImage(video, 0, 0, ctx.canvas.width, ctx.canvas.height);
}

export function drawSkeleton(ctx, landmarks) {
  const { width: w, height: h } = ctx.canvas;
  const px = (i) => ({ x: landmarks[i].x * w, y: landmarks[i].y * h });
  const isVisible = (i) => (landmarks[i].visibility ?? 1) > MIN_VISIBILITY;

  ctx.lineWidth = 4;
  ctx.strokeStyle = "#22d3ee";
  for (const [a, b] of CONNECTIONS) {
    if (!isVisible(a) || !isVisible(b)) continue;
    const p1 = px(a), p2 = px(b);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }

  ctx.fillStyle = "#f43f5e";
  for (const i of Object.values(POINTS)) {
    if (!isVisible(i)) continue;
    const p = px(i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function clearCanvas(ctx) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}