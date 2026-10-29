import { isMac } from "./platform";

export type CommandId =
  | "newTab"
  | "open"
  | "save"
  | "saveAs"
  | "saveAll"
  | "closeTab"
  | "quit"
  | "undo"
  | "redo"
  | "cut"
  | "copy"
  | "paste"
  | "selectAll"
  | "find"
  | "findNext"
  | "findPrev"
  | "replace"
  | "gotoLine"
  | "timeDate"
  | "zoomIn"
  | "zoomOut"
  | "zoomReset"
  | "toggleWrap"
  | "toggleStatusBar"
  | "toggleSpell"
  | "nextTab"
  | "prevTab";

export type ToggleSetting = "wordWrap" | "statusBar" | "spellcheck";

export interface CommandItem {
  id: CommandId;
  label: string;
  /** Atalho no formato "Mod+Shift+S"; Mod é Cmd no Mac e Ctrl no Windows. */
  keys?: string;
  toggle?: ToggleSetting;
  /** No Mac usa o item nativo do sistema (necessário para a área de transferência). */
  macNative?: "Cut" | "Copy" | "Paste";
  /** Fora do Mac; no Mac o item fica no menu do aplicativo. */
  notMac?: boolean;
}

export type MenuEntry = CommandItem | "-";

export interface MenuDef {
  label: string;
  items: MenuEntry[];
}

export const MENUS: MenuDef[] = [
  {
    label: "Arquivo",
    items: [
      { id: "newTab", label: "Nova aba", keys: "Mod+N" },
      { id: "open", label: "Abrir…", keys: "Mod+O" },
      "-",
      { id: "save", label: "Salvar", keys: "Mod+S" },
      { id: "saveAs", label: "Salvar como…", keys: "Mod+Shift+S" },
      { id: "saveAll", label: "Salvar tudo", keys: "Mod+Alt+S" },
      "-",
      { id: "closeTab", label: "Fechar aba", keys: "Mod+W" },
      { id: "quit", label: "Sair", notMac: true },
    ],
  },
  {
    label: "Editar",
    items: [
      { id: "undo", label: "Desfazer", keys: "Mod+Z" },
      { id: "redo", label: "Refazer", keys: "Mod+Shift+Z" },
      "-",
      { id: "cut", label: "Recortar", keys: "Mod+X", macNative: "Cut" },
      { id: "copy", label: "Copiar", keys: "Mod+C", macNative: "Copy" },
      { id: "paste", label: "Colar", keys: "Mod+V", macNative: "Paste" },
      "-",
      { id: "find", label: "Localizar…", keys: "Mod+F" },
      { id: "findNext", label: "Localizar próxima", keys: isMac ? "Mod+G" : "F3" },
      { id: "findPrev", label: "Localizar anterior", keys: isMac ? "Mod+Shift+G" : "Shift+F3" },
      { id: "replace", label: "Substituir…", keys: isMac ? "Mod+Alt+F" : "Mod+H" },
      { id: "gotoLine", label: "Ir para a linha…", keys: isMac ? "Mod+L" : "Mod+G" },
      "-",
      { id: "selectAll", label: "Selecionar tudo", keys: "Mod+A" },
      { id: "timeDate", label: "Data e hora", keys: "F5" },
    ],
  },
  {
    label: "Exibir",
    items: [
      { id: "zoomIn", label: "Ampliar", keys: "Mod+=" },
      { id: "zoomOut", label: "Reduzir", keys: "Mod+-" },
      { id: "zoomReset", label: "Restaurar zoom padrão", keys: "Mod+0" },
      "-",
      { id: "toggleWrap", label: "Quebra automática de linha", toggle: "wordWrap" },
      { id: "toggleStatusBar", label: "Barra de status", toggle: "statusBar" },
      { id: "toggleSpell", label: "Verificação ortográfica", toggle: "spellcheck" },
    ],
  },
];

/** Atalhos que não aparecem nos menus. */
const EXTRA_KEYS: [string, CommandId][] = [
  ["Mod+T", "newTab"],
  ["Mod+Shift+=", "zoomIn"],
  ["Ctrl+Tab", "nextTab"],
  ["Ctrl+Shift+Tab", "prevTab"],
  ...(isMac
    ? ([
        ["Mod+Shift+]", "nextTab"],
        ["Mod+Shift+[", "prevTab"],
      ] as [string, CommandId][])
    : ([
        ["Mod+Y", "redo"],
        ["Mod+PageDown", "nextTab"],
        ["Mod+PageUp", "prevTab"],
      ] as [string, CommandId][])),
];

/** Atalhos do navegador embutido que não fazem sentido num editor. */
export const BLOCKED_KEYS = ["Mod+R", "Mod+Shift+R", "Mod+P", "F7"];

/**
 * Atalhos tratados pelo próprio app. Recortar/copiar/colar ficam com o
 * navegador embutido, que lida melhor com a área de transferência.
 */
export const KEY_BINDINGS: [string, CommandId][] = [
  ...MENUS.flatMap((menu) =>
    menu.items.flatMap((item): [string, CommandId][] =>
      item !== "-" && item.keys && !item.macNative ? [[item.keys, item.id]] : [],
    ),
  ),
  ...EXTRA_KEYS,
];

const CODES: Record<string, string> = {
  "=": "Equal",
  "-": "Minus",
  "[": "BracketLeft",
  "]": "BracketRight",
};

function keyCode(key: string): string {
  if (/^[A-Z]$/.test(key)) return `Key${key}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return CODES[key] ?? key;
}

function parse(keys: string) {
  const parts = keys.split("+");
  // "Mod++" não é usado; "-" e "=" são teclas comuns.
  const key = parts.pop()!;
  return {
    key,
    mod: parts.includes("Mod"),
    ctrl: parts.includes("Ctrl"),
    shift: parts.includes("Shift"),
    alt: parts.includes("Alt"),
  };
}

export function matchesKeys(keys: string, e: KeyboardEvent): boolean {
  const k = parse(keys);
  if (isMac) {
    if (k.mod !== e.metaKey || k.ctrl !== e.ctrlKey) return false;
  } else if ((k.mod || k.ctrl) !== e.ctrlKey || e.metaKey) {
    return false;
  }
  return k.shift === e.shiftKey && k.alt === e.altKey && e.code === keyCode(k.key);
}

/** Converte para o formato de atalho dos menus nativos do Tauri. */
export function toAccelerator(keys: string): string {
  return keys.replace("Mod", "CmdOrCtrl");
}

const KEY_NAMES: Record<string, string> = { "=": "+", "-": "-" };

/** Texto do atalho nos menus desenhados em HTML (Windows/Linux). */
export function formatKeys(keys: string): string {
  const { key, mod, ctrl, shift, alt } = parse(keys);
  return [mod || ctrl ? "Ctrl" : "", alt ? "Alt" : "", shift ? "Shift" : "", KEY_NAMES[key] ?? key]
    .filter(Boolean)
    .join("+");
}
