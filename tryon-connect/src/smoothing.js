// Lissage exponentiel des mesures du corps, pour supprimer les tremblements.
// Toutes les valeurs numériques sont lissées, y compris celles rangées dans
// des sous-objets (points de contrôle { x, y } de la déformation).

// Nombre d'images sans détection avant de faire disparaître le vêtement
const MAX_MISSED_FRAMES = 8;

// Copie profonde simple (nombres, objets, null)
function clone(value) {
  if (value === null || typeof value !== "object") return value;
  const out = {};
  for (const k in value) out[k] = clone(value[k]);
  return out;
}

// Rapproche "state" de "measure" d'une fraction alpha, champ par champ.
// Si un point apparaît ou disparaît (null), on prend directement la mesure.
function blend(state, measure, alpha) {
  for (const key in measure) {
    const m = measure[key];
    const s = state[key];
    if (typeof m === "number" && typeof s === "number") {
      state[key] = s + alpha * (m - s);
    } else if (m && typeof m === "object" && s && typeof s === "object") {
      blend(s, m, alpha);
    } else {
      state[key] = clone(m);
    }
  }
}

export function createSmoother() {
  let state = null;   // dernière valeur lissée
  let missed = 0;     // images consécutives sans détection

  return {
    // measure : mesure brute (ou null si personne détecté)
    // smoothing : 0 = aucun lissage, 0.95 = très lisse
    update(measure, smoothing) {
      if (!measure) {
        missed++;
        if (missed > MAX_MISSED_FRAMES) state = null;
        return state; // on garde la dernière position quelques images
      }

      missed = 0;

      // Première mesure : rien à lisser, on part de là
      if (!state) {
        state = clone(measure);
        return state;
      }

      blend(state, measure, 1 - smoothing);
      return state;
    },

    reset() {
      state = null;
      missed = 0;
    },
  };
}
