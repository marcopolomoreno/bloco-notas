import { invoke } from "@tauri-apps/api/core";

export type Encoding = "utf-8" | "utf-8-bom" | "utf-16le" | "utf-16be" | "windows-1252";
export type LineEnding = "lf" | "crlf" | "cr";

export interface TextFile {
  content: string;
  encoding: Encoding;
  mtime: number | null;
}

/** Comandos implementados em `src-tauri/src/lib.rs`. */
export const backend = {
  loadSession: () => invoke<string | null>("load_session"),
  saveSession: (json: string) => invoke<void>("save_session", { json }),
  loadBuffer: (id: string) => invoke<string | null>("load_buffer", { id }),
  saveBuffer: (id: string, content: string) => invoke<void>("save_buffer", { id, content }),
  deleteBuffer: (id: string) => invoke<void>("delete_buffer", { id }),
  pruneBuffers: (keep: string[]) => invoke<void>("prune_buffers", { keep }),
  readTextFile: (path: string) => invoke<TextFile>("read_text_file", { path }),
  writeTextFile: (path: string, content: string, encoding: Encoding) =>
    invoke<number | null>("write_text_file", { path, content, encoding }),
  fileMtime: (path: string) => invoke<number | null>("file_mtime", { path }),
  takePendingFiles: () => invoke<string[]>("take_pending_files"),
  quit: () => invoke<void>("quit"),
};
