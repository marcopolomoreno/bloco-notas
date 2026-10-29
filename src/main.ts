import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { App } from "./app";
import { isMac } from "./platform";
import { installHtmlMenu, installKeyboard, installNativeMenu } from "./ui/menus";

async function start() {
  document.body.classList.toggle("mac", isMac);

  const app = new App();
  await app.restore();

  installKeyboard(app);
  if (isMac) await installNativeMenu(app).catch((err) => console.error("Falha ao criar o menu", err));
  else installHtmlMenu(app, document.getElementById("menubar")!);

  // Arquivos abertos pelo Finder, pela linha de comando ou arrastados para a janela.
  await listen("open-files", () => void app.openPending());
  await getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type === "drop") void app.openFiles(event.payload.paths);
  });
  await app.openPending();

  // Fechar a janela não pergunta nada: a sessão é gravada e restaurada depois.
  await getCurrentWindow().onCloseRequested(() => app.flush());
  window.addEventListener("blur", () => void app.flush());
  window.addEventListener("focus", () => void app.checkExternalChanges());
}

start().catch((err) => console.error(err));
