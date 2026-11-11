// Serveur de jetons minimal pour le Mode Réaliste IA (Decart).
//
// UNE seule route : POST /api/tokens
//   → crée un jeton client TEMPORAIRE (ek_…) avec la clé API permanente (dct_…)
//     lue dans le fichier .env, et le renvoie au navigateur.
// La clé permanente ne quitte jamais ce serveur et n'est jamais écrite dans les logs.
// Aucune image ni vidéo ne passe par ici.
import express from "express";
import { createDecartClient } from "@decartai/sdk";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// --- Lecture du fichier .env (fonction intégrée à Node, sans dépendance) ---
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (existsSync(envFile) && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(envFile);
}

const API_KEY = process.env.DECART_API_KEY?.trim() || "";
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1"; // local uniquement par défaut
const TOKEN_TTL = 60; // secondes : le jeton sert seulement à ouvrir la connexion
const MAX_SESSION = Number(process.env.DECART_MAX_SESSION_SECONDS) || 300;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Modèle de try-on recommandé (alias) + sa version actuelle
const ALLOWED_MODELS = ["lucy-vton-latest", "lucy-vton-3.6"];

// Petite limite anti-abus : 20 jetons par minute et par adresse
const RATE_LIMIT = 20;
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  return list.length > RATE_LIMIT;
}

// Masque toute clé qui se glisserait dans un message d'erreur
const redact = (s) => String(s ?? "").replace(/\b(dct|ek)_[A-Za-z0-9_\-.]+/g, "$1_***");

const decart = API_KEY ? createDecartClient({ apiKey: API_KEY, telemetry: false }) : null;

const app = express();
app.disable("x-powered-by");

app.post("/api/tokens", async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!decart) {
    return res.status(500).json({
      code: "NO_API_KEY",
      error: "DECART_API_KEY absente : crée le fichier .env (voir .env.example).",
    });
  }
  if (rateLimited(req.ip)) {
    return res.status(429).json({ code: "RATE_LIMITED", error: "Trop de demandes de jetons." });
  }
  try {
    const token = await decart.tokens.create({
      expiresIn: TOKEN_TTL,
      allowedModels: ALLOWED_MODELS,
      constraints: { realtime: { maxSessionDuration: MAX_SESSION } },
      ...(ALLOWED_ORIGINS.length ? { allowedOrigins: ALLOWED_ORIGINS } : {}),
    });
    // On ne renvoie que le strict nécessaire
    res.json({ apiKey: token.apiKey, expiresAt: token.expiresAt });
  } catch (err) {
    console.error("Création de jeton échouée :", err?.code ?? "", redact(err?.message));
    res.status(502).json({ code: "TOKEN_CREATE_ERROR", error: "Decart a refusé la création du jeton." });
  }
});

// Vérification rapide (n'indique que la PRÉSENCE de la clé, jamais sa valeur)
app.get("/api/health", (_req, res) => res.json({ ok: true, apiKeyConfigured: Boolean(decart) }));

app.listen(PORT, HOST, () => {
  console.log(
    `Serveur de jetons : http://${HOST}:${PORT}/api/tokens ` +
    `(clé API ${decart ? "configurée" : "ABSENTE — voir .env.example"}, session max ${MAX_SESSION} s)`
  );
});
