// Réglages du Mode Réaliste IA, faciles à modifier.
// (Fichier séparé : le SDK Decart n'est chargé qu'à la première utilisation du mode IA.)

export const MODEL_ID = "lucy-vton-latest";   // alias recommandé par la doc (→ lucy-vton-3.6)
export const COST_PER_SECOND = 0.02;          // $ par seconde (tarif 720p standard Decart)
export const DEFAULT_MAX_SECONDS = 60;        // durée max d'une session
export const EXTEND_SECONDS = 60;             // ajout du bouton "Prolonger"
export const NO_PERSON_TIMEOUT_MS = 15000;    // déconnexion si personne pendant 15 s
export const ENHANCE_PROMPT = true;           // amélioration auto du prompt (défaut recommandé)
