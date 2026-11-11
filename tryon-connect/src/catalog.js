// Liste des articles disponibles : catalogue permanent (garments.js) + articles importés.
import { GARMENTS } from "./garments.js";

const items = new Map();

// Articles du catalogue permanent (copiés : les réglages modifiés en direct
// ne touchent pas l'objet d'origine)
for (const [id, g] of Object.entries(GARMENTS)) {
  items.set(id, {
    id,
    ...g,
    anchors: structuredClone(g.anchors),
    fit: { ...g.fit },
    builtIn: true,
  });
}

export function listGarments() {
  return [...items.values()];
}

export function getGarment(id) {
  return items.get(id) ?? null;
}

export function hasGarment(id) {
  return items.has(id);
}

export function addGarment(g) {
  items.set(g.id, g);
}

export function removeGarment(id) {
  const g = items.get(id);
  if (!g || g.builtIn) return null;
  items.delete(id);
  return g;
}

// Identifiant lisible et unique à partir d'un nom de fichier
// ("Pull Bleu été.jpg" → "pull-bleu-ete"), utilisable comme clé JS et nom de fichier
export function makeId(name) {
  const base =
    name
      .replace(/\.[a-z0-9]+$/i, "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "article";
  let id = base, n = 2;
  while (items.has(id)) id = `${base}-${n++}`;
  return id;
}
