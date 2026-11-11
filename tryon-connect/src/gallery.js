// Galerie de vignettes : choisir, ajuster, supprimer, importer (bouton ou glisser-déposer).

const ACCEPTED = ["image/png", "image/jpeg", "image/webp"];

export function createGallery({ container, dropZone, fileInput, onSelect, onRemove, onAdjust, onFiles }) {
  // --- Import : bouton et glisser-déposer ---
  fileInput.addEventListener("change", () => {
    const files = [...fileInput.files].filter((f) => ACCEPTED.includes(f.type));
    fileInput.value = ""; // permet de réimporter le même fichier
    if (files.length) onFiles(files);
  });

  let dragDepth = 0;
  dropZone.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragDepth++;
    dropZone.classList.add("dragging");
  });
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  dropZone.addEventListener("dragleave", () => {
    if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("dragging"); }
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0;
    dropZone.classList.remove("dragging");
    const files = [...(e.dataTransfer?.files ?? [])].filter((f) => ACCEPTED.includes(f.type));
    if (files.length) onFiles(files);
  });

  // --- Affichage ---
  function render(garments, activeId) {
    container.replaceChildren();
    for (const g of garments) {
      const item = document.createElement("div");
      item.className = "thumb" + (g.id === activeId ? " active" : "");
      item.title = g.warning ? `${g.name} — ⚠ ${g.warning}` : g.name;

      const main = document.createElement("button");
      main.type = "button";
      main.className = "thumb-main";
      main.setAttribute("aria-pressed", String(g.id === activeId));
      main.addEventListener("click", () => onSelect(g.id));

      const img = document.createElement("img");
      img.alt = "";
      img.src = g.src;
      img.loading = "lazy";
      img.addEventListener("error", () => {
        item.classList.add("broken");
        item.title = `${g.name} — image introuvable (${g.src})`;
      });

      const name = document.createElement("span");
      name.className = "thumb-name";
      name.textContent = g.name;
      main.append(img, name);
      item.append(main);

      if (g.warning) {
        const warn = document.createElement("span");
        warn.className = "thumb-warn";
        warn.textContent = "⚠";
        warn.setAttribute("aria-label", g.warning);
        item.append(warn);
      }

      if (!g.builtIn) {
        const del = document.createElement("button");
        del.type = "button";
        del.className = "thumb-x";
        del.textContent = "×";
        del.title = "Supprimer cet article";
        del.addEventListener("click", (e) => { e.stopPropagation(); onRemove(g.id); });
        item.append(del);
      }

      if (g.id === activeId) {
        const adj = document.createElement("button");
        adj.type = "button";
        adj.className = "thumb-adjust";
        adj.textContent = "Ajuster";
        adj.addEventListener("click", (e) => { e.stopPropagation(); onAdjust(g.id); });
        item.append(adj);
      }

      container.append(item);
    }
  }

  return { render };
}
