import { APP_NAME } from "../platform";

let openModals = 0;

export const isModalOpen = () => openModals > 0;

interface DialogButton<T> {
  label: string;
  value: T;
  primary?: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

/** Caixa de diálogo modal; Esc devolve `cancel`. */
export function showDialog<T>(title: string, message: string, buttons: DialogButton<T>[], cancel: T): Promise<T> {
  return new Promise((resolve) => {
    openModals++;
    const previousFocus = document.activeElement as HTMLElement | null;
    const overlay = element("div", "overlay");
    const box = element("div", "dialog");
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    const heading = element("h2");
    heading.textContent = title;
    const text = element("p");
    text.textContent = message;
    const row = element("div", "dialog-buttons");

    const finish = (value: T) => {
      openModals--;
      overlay.remove();
      previousFocus?.focus();
      resolve(value);
    };

    let primary: HTMLButtonElement | null = null;
    for (const b of buttons) {
      const button = element("button", b.primary ? "primary" : "");
      button.textContent = b.label;
      button.addEventListener("click", () => finish(b.value));
      if (b.primary) primary = button;
      row.append(button);
    }

    overlay.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        finish(cancel);
      } else if (e.key === "Tab") {
        // Mantém o foco dentro da caixa.
        const all = [...row.querySelectorAll("button")];
        const index = all.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();
        all[(index + (e.shiftKey ? all.length - 1 : 1)) % all.length]?.focus();
      }
    });

    box.append(heading, text, row);
    overlay.append(box);
    document.body.append(overlay);
    (primary ?? row.querySelector("button"))?.focus();
  });
}

export type SaveChoice = "save" | "discard" | "cancel";

export function askToSave(name: string): Promise<SaveChoice> {
  return showDialog<SaveChoice>(
    APP_NAME,
    `Deseja salvar as alterações em "${name}"?`,
    [
      { label: "Salvar", value: "save", primary: true },
      { label: "Não salvar", value: "discard" },
      { label: "Cancelar", value: "cancel" },
    ],
    "cancel",
  );
}

export function showMessage(title: string, message: string): Promise<void> {
  return showDialog(title, message, [{ label: "OK", value: undefined, primary: true }], undefined);
}

export interface PopupOption<T> {
  label: string;
  value: T;
  checked?: boolean;
}

/** Menu suspenso que abre acima de `anchor` (usado na barra de status). */
export function popupMenu<T>(anchor: HTMLElement, options: PopupOption<T>[]): Promise<T | null> {
  return new Promise((resolve) => {
    const menu = element("div", "popup-menu");
    menu.setAttribute("role", "menu");

    const finish = (value: T | null) => {
      document.removeEventListener("mousedown", onOutside, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", onBlur);
      menu.remove();
      resolve(value);
    };
    const onOutside = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) finish(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        finish(null);
      }
    };
    const onBlur = () => finish(null);

    for (const option of options) {
      const item = element("button", "menu-item");
      item.setAttribute("role", "menuitemradio");
      item.setAttribute("aria-checked", String(!!option.checked));
      const check = element("span", "menu-check");
      check.textContent = option.checked ? "✓" : "";
      const label = element("span", "menu-label");
      label.textContent = option.label;
      item.append(check, label);
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => finish(option.value));
      menu.append(item);
    }

    document.body.append(menu);
    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.bottom = `${window.innerHeight - rect.top + 4}px`;

    document.addEventListener("mousedown", onOutside, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", onBlur);
  });
}
