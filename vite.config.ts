import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

// Configuração recomendada pelo Tauri: porta fixa e sem limpar o terminal.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // macOS 11 usa o WebKit do Safari 14; no Windows o WebView2 é Chromium.
    target: process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari14",
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
