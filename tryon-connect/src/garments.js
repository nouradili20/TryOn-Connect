// Catalogue de démonstration.
//
// name        : nom affiché
// description : (facultatif) description du vêtement pour le Mode Réaliste IA,
//               idéalement en anglais, ex. "a black turtleneck knit sweater with short sleeves"
//
// anchors (en pixels dans l'image, vue de face) :
//   shoulderLeft / shoulderRight = épaules à GAUCHE / DROITE de l'image
//   hipY = hauteur de la ligne des hanches
// anchors OPTIONNELS (utilisés par la déformation, valeurs par défaut sinon) :
//   waistY      : hauteur de la taille          (défaut : 60 % épaules → hanches)
//   hemY        : bas du vêtement               (défaut : bas de l'image opaque)
//   armpitY     : hauteur des aisselles         (défaut : 45 % épaules → hanches)
//   sleeveAngle : angle des manches dans l'image, en degrés depuis la verticale (défaut : 20)
//
// fit (valeurs relatives au corps) :
//   widthScale  : multiplie la largeur          (1 = taille calculée)
//   lengthScale : multiplie la longueur         (1 = taille calculée)
//   offsetY     : décalage vertical, en fraction du torse (négatif = monter)

//   shoulderLift   : remonte les épaules du vêtement, en fraction de la largeur
//                    d'épaules (les points MediaPipe sont sur l'articulation,
//                    plus bas que le vrai contour de l'épaule)
//   shoulderSpread : écarte UNIQUEMENT le haut du vêtement (taille et hanches
//                    inchangées). Ces deux valeurs sont des MINIMUMS : l'ajustement
//                    automatique ("Épaules auto") peut aller plus loin si besoin.
//   (utilisés par la déformation ; ignorés par la version rigide)
export const DEFAULT_FIT = {
  widthScale: 1,
  lengthScale: 1,
  offsetY: 0,
  shoulderLift: 0.08,
  shoulderSpread: 1.08,
};

export const GARMENTS = {
  "tshirt-test": {
    name: "T-shirt test",
    description: "a plain short-sleeved crew-neck t-shirt",
    src: "/garments/tshirt-test.svg",
    anchors: {
      shoulderLeft: { x: 300, y: 220 },
      shoulderRight: { x: 700, y: 220 },
      hipY: 1050,
    },
    fit: { widthScale: 1.2, lengthScale: 1, offsetY: -0.06 },
  },

   "mon-pull": {
    name: "Pull col roulé noir",
    // Facultatif : description envoyée au Mode Réaliste IA (sinon le nom est utilisé)
    description: "a black turtleneck knit sweater with short sleeves",
    src: "/garments/mon-pull.png",
    anchors: {
      // Mesuré sur l'image 422x591 (bbox x 54..368, y 88..502)
      shoulderLeft: { x: 120, y: 145 },
      shoulderRight: { x: 301, y: 145 },
      hipY: 473,
      // Optionnels (mesurés sur le profil de l'image)
      armpitY: 303,   // la manche se détache du corps
      hemY: 502,      // bas de la bande côtelée
      sleeveAngle: 20,
    },
    fit: { widthScale: 1.15, lengthScale: 1, offsetY: -0.05 },
  },
};