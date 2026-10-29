export const APP_NAME = "Bloco de Notas";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Quebra de linha usada em abas novas. */
export const DEFAULT_LINE_ENDING = isMac ? "lf" : "crlf";
