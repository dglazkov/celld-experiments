import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The celld node serves the built app in production; in development Vite serves
// the UI and proxies /api (including the WebSocket upgrade) to `celld dev`.
const CELLD_DEV = process.env.CELLD_DEV_URL ?? "http://127.0.0.1:9876";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    // exe.dev proxies https://<vm>.exe.xyz/ to the VM, so Vite has to accept
    // that Host header. See https://exe.dev/docs/faq/nextjs-and-friends.md
    allowedHosts: [".exe.xyz"],
    proxy: {
      "/api": { target: CELLD_DEV, changeOrigin: true, ws: true },
    },
  },
});
