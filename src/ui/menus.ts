import { getVersion } from "@tauri-apps/api/app";
import { CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu } from "@tauri-apps/api/menu";
import type { App } from "../app";
import {
  BLOCKED_KEYS,
  KEY_BINDINGS,
  MENUS,
  formatKeys,
  matchesKeys,
  toAccelerator,
  type CommandItem,
  type ToggleSetting,
} from "../commands";
import { APP_NAME, isMac } from "../platform";
import { isModalOpen } from "./dialogs";

/** Atalhos de teclado, tratados antes do editor para não haver conflito. */
export function installKeyboard(app: App) {
  window.addEventListener(
    "keydown",
    (e) => {
      if (isModalOpen() || e.isComposing) return;
      const modOnly = (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && !e.shiftKey;
      if (modOnly && /^Digit[1-9]$/.test(e.code)) {
        e.preventDefault();
        app.selectTabByNumber(Number(e.code.slice(5)));
        return;
      }
      for (const [keys, id] of KEY_BINDINGS) {
        if (matchesKeys(keys, e)) {
          e.preventDefault();
          e.stopPropagation();
          void app.run(id, "key");
          return;
        }
      }
      if (BLOCKED_KEYS.some((keys) => matchesKeys(keys, e))) e.preventDefault();
    },
    true,
  );
}

/** Barra de menus nativa do macOS. */
export async function installNativeMenu(app: App) {
  const checks = new Map<ToggleSetting, CheckMenuItem>();
  const separator = () => PredefinedMenuItem.new({ item: "Separator" });

  const makeItem = async (item: CommandItem) => {
    if (item.macNative) return PredefinedMenuItem.new({ item: item.macNative, text: item.label });
    const action = () => void app.run(item.id, "menu");
    const create = (accelerator?: string) =>
      item.toggle
        ? CheckMenuItem.new({ id: item.id, text: item.label, accelerator, action, checked: app.settings[item.toggle] })
        : MenuItem.new({ id: item.id, text: item.label, accelerator, action });
    let created: MenuItem | CheckMenuItem;
    try {
      created = await create(item.keys && toAccelerator(item.keys));
    } catch {
      // Atalho não reconhecido pelo sistema: o item funciona sem ele.
      created = await create();
    }
    if (item.toggle) checks.set(item.toggle, created as CheckMenuItem);
    return created;
  };

  const submenus = [];
  for (const menu of MENUS) {
    const items = [];
    for (const entry of menu.items) {
      if (entry === "-") items.push(await separator());
      else if (!entry.notMac) items.push(await makeItem(entry));
    }
    submenus.push(await Submenu.new({ text: menu.label, items }));
  }

  const appMenu = await Submenu.new({
    text: APP_NAME,
    items: [
      await PredefinedMenuItem.new({
        item: { About: { name: APP_NAME, version: await getVersion() } },
        text: `Sobre o ${APP_NAME}`,
      }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Services", text: "Serviços" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Hide", text: `Ocultar ${APP_NAME}` }),
      await PredefinedMenuItem.new({ item: "HideOthers", text: "Ocultar outros" }),
      await PredefinedMenuItem.new({ item: "ShowAll", text: "Mostrar tudo" }),
      await separator(),
      await MenuItem.new({
        id: "quit",
        text: `Encerrar ${APP_NAME}`,
        accelerator: "CmdOrCtrl+Q",
        action: () => void app.run("quit", "menu"),
      }),
    ],
  });

  const windowMenu = await Submenu.new({
    text: "Janela",
    items: [
      await PredefinedMenuItem.new({ item: "Minimize", text: "Minimizar" }),
      await PredefinedMenuItem.new({ item: "Maximize", text: "Zoom" }),
      await separator(),
      await PredefinedMenuItem.new({ item: "Fullscreen", text: "Tela cheia" }),
    ],
  });

  const menu = await Menu.new({ items: [appMenu, ...submenus, windowMenu] });
  await menu.setAsAppMenu();
  await windowMenu.setAsWindowsMenuForNSApp().catch(() => {});

  app.onSettingsChange = () => {
    for (const [setting, item] of checks) void item.setChecked(app.settings[setting]);
  };
}

/** Menu desenhado em HTML para Windows/Linux, no estilo do Bloco de Notas. */
export function installHtmlMenu(app: App, bar: HTMLElement) {
  const dropdown = document.createElement("div");
  dropdown.className = "menu-dropdown";
  dropdown.setAttribute("role", "menu");
  dropdown.hidden = true;
  document.body.append(dropdown);
  let openIndex = -1;

  const close = () => {
    openIndex = -1;
    dropdown.hidden = true;
    buttons.forEach((b) => b.classList.remove("open"));
  };

  const open = (index: number) => {
    openIndex = index;
    buttons.forEach((b, i) => b.classList.toggle("open", i === index));
    dropdown.replaceChildren(
      ...MENUS[index].items.map((entry) => {
          if (entry === "-") {
            const hr = document.createElement("div");
            hr.className = "menu-separator";
            return hr;
          }
          const item = document.createElement("button");
          item.className = "menu-item";
          item.setAttribute("role", entry.toggle ? "menuitemcheckbox" : "menuitem");
          const check = document.createElement("span");
          check.className = "menu-check";
          if (entry.toggle) {
            const on = app.settings[entry.toggle];
            check.textContent = on ? "✓" : "";
            item.setAttribute("aria-checked", String(on));
          }
          const label = document.createElement("span");
          label.className = "menu-label";
          label.textContent = entry.label;
          const keys = document.createElement("span");
          keys.className = "menu-keys";
          keys.textContent = entry.keys ? formatKeys(entry.keys) : "";
          item.append(check, label, keys);
          item.addEventListener("mousedown", (e) => e.preventDefault());
          item.addEventListener("click", () => {
            close();
            void app.run(entry.id, "menu");
          });
          return item;
        }),
    );
    const rect = buttons[index].getBoundingClientRect();
    dropdown.style.left = `${rect.left}px`;
    dropdown.style.top = `${rect.bottom + 2}px`;
    dropdown.hidden = false;
  };

  const buttons = MENUS.map((menu, index) => {
    const button = document.createElement("button");
    button.className = "menubar-button";
    button.textContent = menu.label;
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (openIndex === index) close();
      else open(index);
    });
    button.addEventListener("mouseenter", () => {
      if (openIndex !== -1 && openIndex !== index) open(index);
    });
    bar.append(button);
    return button;
  });

  document.addEventListener(
    "mousedown",
    (e) => {
      const target = e.target as Node;
      if (openIndex !== -1 && !dropdown.contains(target) && !bar.contains(target)) close();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && openIndex !== -1) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    },
    true,
  );
  window.addEventListener("blur", close);
}
