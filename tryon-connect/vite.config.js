import { defineConfig } from "vite";

// En développement, /api est redirigé vers le serveur de jetons (server/index.js).
// La clé API reste sur ce serveur : elle n'est jamais incluse dans le code du navigateur.
export default defineConfig({
  server: {
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.PORT || 8787}`,
        changeOrigin: false,
      },
    },
  },
});
