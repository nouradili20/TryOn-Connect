# TryOn Connect

**Real-time virtual try-on module for e-commerce websites.**
Shoppers click "Try it on", allow their camera, and see the garment on their own body, live, directly from the product page.

![Demo](docs/demo.gif)
<!-- Replace with your own GIF or video: Fast mode vs AI mode, side by side -->

---

## Features

- **Two rendering engines in one module**
  - **Fast mode** (built from scratch): runs 100% in the browser. Body tracking with MediaPipe, garment warping on Canvas. Free, instant, the video never leaves the device.
  - **Realistic AI mode**: photorealistic cloth and drape, powered by Decart's real-time virtual try-on model (Lucy VTON) over WebRTC, with explicit user consent.
- **Fitting room**: import several garment images at once, switch between them live.
- **Automatic garment processing**: background removal, auto-cropping and automatic anchor detection (shoulders, hips), with a drag-and-drop calibration tool.
- **Realism pipeline (fast mode)**
  - Hair, chin and forearms rendered in front of the garment (MediaPipe multiclass segmentation)
  - Mesh warping so the garment follows the torso shape
  - Lighting transfer, edge feathering, camera grain and white-balance matching
  - One Euro filter for stable, low-latency tracking
- **Cost control (AI mode)**: session time limit, countdown, auto-disconnect when the tab is hidden, live cost estimate.
- **Secure by design**: the API key stays on the server, the browser only receives short-lived tokens.

## Tech stack

| Area | Technologies |
|---|---|
| Front-end | HTML5, CSS3, JavaScript (ES modules), Vite |
| Computer vision | MediaPipe Pose Landmarker, MediaPipe Image Segmenter |
| Rendering | HTML Canvas 2D (affine mesh warping, compositing) |
| Camera | getUserMedia, WebRTC |
| AI engine | Decart SDK (real-time virtual try-on) |
| Token server | Node.js, Express |
| Storage | IndexedDB (imported garments, local only) |

## Architecture

```
tryon-connect/
├── public/
│   ├── garments/        # demo garment images
│   ├── mediapipe/wasm/  # self-hosted MediaPipe runtime
│   └── models/          # pose + segmentation models
├── server/              # minimal token server (one route)
└── src/
    ├── engines/         # fastEngine (local) + aiEngine (Decart)
    ├── camera.js        # camera access
    ├── poseDetector.js  # body landmarks
    ├── segmenter.js     # hair / skin / clothes masks
    ├── meshWarp.js      # garment deformation
    ├── lighting.js      # shading and camera matching
    ├── garmentImport.js # background removal + auto anchors
    └── main.js          # UI and render loop
```

The engine does not depend on any store: a garment is just an image, anchors and fit settings. This makes the module reusable across any e-commerce site.

## Getting started

Requirements: Node.js 20+

```bash
git clone https://github.com/<your-username>/tryon-connect.git
cd tryon-connect
npm install
```

**Fast mode only** (no account needed):

```bash
npm run dev
```

**With AI mode**: create a key on [platform.decart.ai](https://platform.decart.ai), then:

```bash
cp .env.example .env     # Windows: Copy-Item .env.example .env
# add your key to .env: DECART_API_KEY=...
npm run dev:all
```

Open http://localhost:5173.

> The camera requires a secure context: `localhost` in development, HTTPS in production.

## Privacy

- **Fast mode**: all processing happens on the device. No image or video is sent or stored.
- **AI mode**: the video stream is sent to Decart for real-time processing, only after the user explicitly accepts. Nothing is recorded by this module.

## Known limitations

- Fast mode is a 2D overlay: best results with a front-facing pose, arms close to the body, and upper-body garments.
- Garment images should be front-facing, flat or ghost-mannequin photos.
- AI mode is billed per second of generation by the provider.

## Roadmap

- [ ] Embeddable iframe + one-line integration script for any store
- [ ] postMessage API so the store can send the product to try on
- [ ] Color variants
- [ ] Demo e-commerce store

## Credits

- [MediaPipe](https://developers.google.com/mediapipe) by Google (Apache 2.0)
- Real-time AI try-on model by [Decart](https://decart.ai)

## Author

**Nour** — Full-stack web developer
[LinkedIn](https://www.linkedin.com/in/<your-profile>) · [GitHub](https://github.com/<your-username>)
