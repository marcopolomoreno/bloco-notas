import type { EditorState, Text } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { redo, selectAll, undo } from "@codemirror/commands";
import { findNext, findPrevious, gotoLine, openSearchPanel } from "@codemirror/search";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { backend, type Encoding, type LineEnding } from "./backend";
import type { CommandId } from "./commands";
import { createEditorState, optionEffects } from "./editor";
import { APP_NAME, DEFAULT_LINE_ENDING, isMac } from "./platform";
import { askToSave, isModalOpen, nativeDialog, popupMenu, showMessage } from "./ui/dialogs";

export interface Settings {
  wordWrap: boolean;
  statusBar: boolean;
  spellcheck: boolean;
  zoom: number;
}

const DEFAULT_SETTINGS: Settings = { wordWrap: true, statusBar: true, spellcheck: true, zoom: 100 };
const BASE_FONT_SIZE = 14;
const FLUSH_DELAY = 400;

interface Tab {
  id: string;
  path: string | null;
  encoding: Encoding;
  lineEnding: LineEnding;
  /** Data de modificação do arquivo quando foi lido ou salvo. */
  mtime: number | null;
  state: EditorState;
  /** Conteúdo igual ao que está no disco; null quando não há referência. */
  savedDoc: Text | null;
  dirty: boolean;
  scrollTop: number;
}

interface SessionTab {
  id: string;
  path: string | null;
  encoding: Encoding;
  lineEnding: LineEnding;
  mtime: number | null;
  dirty: boolean;
  anchor: number;
  head: number;
  scrollTop: number;
}

interface Session {
  version: 1;
  activeId: string | null;
  settings: Settings;
  tabs: SessionTab[];
}

interface TabInit {
  id?: string;
  path?: string | null;
  content?: string;
  encoding?: Encoding;
  lineEnding?: LineEnding;
  mtime?: number | null;
  dirty?: boolean;
  anchor?: number;
  head?: number;
  scrollTop?: number;
}

const ENCODING_LABELS: Record<Encoding, string> = {
  "utf-8": "UTF-8",
  "utf-8-bom": "UTF-8 com BOM",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "windows-1252": "ANSI",
};

const LINE_ENDING_LABELS: Record<LineEnding, string> = {
  crlf: "Windows (CRLF)",
  lf: "Unix (LF)",
  cr: "Macintosh (CR)",
};

const LINE_SEPARATORS: Record<LineEnding, string> = { crlf: "\r\n", lf: "\n", cr: "\r" };

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function newId(): string {
  return crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function sameDoc(a: Text, b: Text): boolean {
  return a === b || (a.length === b.length && a.eq(b));
}

function detectLineEnding(text: string, fallback: LineEnding = DEFAULT_LINE_ENDING): LineEnding {
  const lf = text.indexOf("\n");
  if (lf === -1) return text.includes("\r") ? "cr" : fallback;
  return lf > 0 && text[lf - 1] === "\r" ? "crlf" : "lf";
}

function focusedInput(): HTMLInputElement | null {
  const el = document.activeElement;
  return el instanceof HTMLInputElement ? el : null;
}

/** Mesmo formato do F5 do Bloco de Notas: "14:35 29/10/2026". */
function timeDate(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())} ${pad(now.getDate())}/${pad(now.getMonth() + 1)}/${now.getFullYear()}`;
}

const formatNumber = (n: number) => n.toLocaleString("pt-BR");

export class App {
  readonly view: EditorView;
  settings: Settings = { ...DEFAULT_SETTINGS };
  /** Chamado quando as configurações mudam (para atualizar as marcas dos menus). */
  onSettingsChange = () => {};

  private tabs: Tab[] = [];
  private active: Tab | null = null;
  private pendingBuffers = new Set<string>();
  private flushTimer: number | undefined;
  private flushChain: Promise<void> = Promise.resolve();
  private lastCommand = { id: "", source: "", time: 0 };
  private zoomDelta = 0;
  private windowTitle = "";
  private tabEls = new Map<string, HTMLElement>();

  private readonly tabStrip = byId("tabs");
  private readonly statusBar = byId("statusbar");
  private readonly statusPos = byId("sb-pos");
  private readonly statusChars = byId("sb-chars");
  private readonly statusZoom = byId("sb-zoom");
  private readonly statusEol = byId<HTMLButtonElement>("sb-eol");
  private readonly statusEncoding = byId<HTMLButtonElement>("sb-enc");

  constructor() {
    const editor = byId("editor");
    this.view = new EditorView({ parent: editor });
    this.view.scrollDOM.addEventListener("scroll", () => this.scheduleFlush(), { passive: true });
    editor.addEventListener("wheel", (e) => this.onZoomWheel(e), { passive: false });

    byId("new-tab").addEventListener("click", () => this.newTab());
    this.tabStrip.addEventListener(
      "wheel",
      (e) => {
        if (e.deltaY && !e.deltaX) {
          this.tabStrip.scrollLeft += e.deltaY;
          e.preventDefault();
        }
      },
      { passive: false },
    );
    this.statusEol.addEventListener("click", () => void this.chooseLineEnding());
    this.statusEncoding.addEventListener("click", () => void this.chooseEncoding());
  }

  // -------------------------------------------------------------------------
  // Comandos
  // -------------------------------------------------------------------------

  async run(id: CommandId, source: "key" | "menu" = "menu"): Promise<void> {
    if (isModalOpen()) return;
    // No Mac o WKWebView entrega Cmd+tecla primeiro à página e só repassa ao
    // menu nativo se ela não chamar preventDefault (installKeyboard chama).
    // Isto é só uma proteção caso algum atalho chegue pelos dois caminhos.
    if (isMac) {
      const now = performance.now();
      const last = this.lastCommand;
      if (last.id === id && last.source !== source && now - last.time < 120) return;
      this.lastCommand = { id, source, time: now };
    }

    const view = this.view;
    const input = focusedInput();
    switch (id) {
      case "newTab":
        return this.newTab();
      case "open":
        return this.openWithDialog();
      case "save":
        if (this.active) await this.saveTab(this.active);
        return;
      case "saveAs":
        if (this.active) await this.saveTab(this.active, true);
        return;
      case "saveAll":
        return this.saveAll();
      case "closeTab":
        if (this.active) await this.closeTab(this.active);
        return;
      case "quit":
        return this.quit();
      case "undo":
        if (input) document.execCommand("undo");
        else undo(view);
        return;
      case "redo":
        if (input) document.execCommand("redo");
        else redo(view);
        return;
      case "cut":
      case "copy":
        return this.copySelection(id === "cut");
      case "paste":
        return this.paste();
      case "selectAll":
        if (input) input.select();
        else selectAll(view);
        return;
      case "find":
        openSearchPanel(view);
        return;
      case "findNext":
        findNext(view);
        return;
      case "findPrev":
        findPrevious(view);
        return;
      case "replace":
        openSearchPanel(view);
        setTimeout(() => view.dom.querySelector<HTMLInputElement>(".cm-search input[name=replace]")?.focus());
        return;
      case "gotoLine":
        gotoLine(view);
        return;
      case "timeDate":
        view.dispatch(view.state.replaceSelection(timeDate()), { scrollIntoView: true, userEvent: "input" });
        return;
      case "zoomIn":
        return this.setZoom(this.settings.zoom + 10);
      case "zoomOut":
        return this.setZoom(this.settings.zoom - 10);
      case "zoomReset":
        return this.setZoom(100);
      case "toggleWrap":
        return this.updateSettings({ wordWrap: !this.settings.wordWrap });
      case "toggleStatusBar":
        return this.updateSettings({ statusBar: !this.settings.statusBar });
      case "toggleSpell":
        return this.updateSettings({ spellcheck: !this.settings.spellcheck });
      case "nextTab":
      case "prevTab": {
        if (!this.active || this.tabs.length < 2) return;
        const step = id === "nextTab" ? 1 : this.tabs.length - 1;
        this.activate(this.tabs[(this.tabs.indexOf(this.active) + step) % this.tabs.length]);
        return;
      }
    }
  }

  /** Cmd/Ctrl+1…8 vão para a aba na posição; 9 vai para a última. */
  selectTabByNumber(n: number) {
    const tab = n === 9 ? this.tabs[this.tabs.length - 1] : this.tabs[n - 1];
    if (tab) this.activate(tab);
  }

  // A área de transferência só passa por aqui no menu HTML (Windows/Linux);
  // pelo teclado e no Mac quem cuida é o próprio navegador embutido.
  private async copySelection(cut: boolean) {
    const input = focusedInput();
    if (input) {
      document.execCommand(cut ? "cut" : "copy");
      return;
    }
    const { state } = this.view;
    const text = state.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => state.sliceDoc(r.from, r.to))
      .join(state.lineBreak);
    if (!text) return;
    await navigator.clipboard.writeText(text);
    if (cut) this.view.dispatch(state.replaceSelection(""), { userEvent: "delete.cut" });
  }

  private async paste() {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (!text) return;
    const input = focusedInput();
    if (input) {
      input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, "end");
      return;
    }
    this.view.dispatch(this.view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.paste" });
  }

  // -------------------------------------------------------------------------
  // Abas
  // -------------------------------------------------------------------------

  private createTab(init: TabInit): Tab {
    const content = init.content ?? "";
    const state = createEditorState(content, this.settings, (u) => this.onEditorUpdate(u), init.anchor, init.head);
    const dirty = init.dirty ?? false;
    return {
      id: init.id ?? newId(),
      path: init.path ?? null,
      encoding: init.encoding ?? "utf-8",
      lineEnding: init.lineEnding ?? detectLineEnding(content),
      mtime: init.mtime ?? null,
      state,
      savedDoc: dirty ? null : state.doc,
      dirty,
      scrollTop: init.scrollTop ?? 0,
    };
  }

  private insertTab(tab: Tab) {
    const index = this.active ? this.tabs.indexOf(this.active) + 1 : this.tabs.length;
    this.tabs.splice(index, 0, tab);
  }

  newTab() {
    const tab = this.createTab({});
    this.insertTab(tab);
    this.activate(tab);
  }

  activate(tab: Tab) {
    if (this.active === tab) {
      this.view.focus();
      return;
    }
    if (this.active) {
      this.active.state = this.view.state;
      this.active.scrollTop = this.view.scrollDOM.scrollTop;
    }
    this.active = tab;
    this.view.setState(tab.state);
    // O estado pode ter sido criado antes de uma mudança de configuração.
    this.view.dispatch({ effects: optionEffects(this.settings) });
    const top = tab.scrollTop;
    requestAnimationFrame(() => {
      if (this.active === tab) this.view.scrollDOM.scrollTop = top;
    });
    this.renderTabs();
    this.renderStatus();
    this.tabEls.get(tab.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
    this.view.focus();
    this.scheduleFlush();
  }

  async closeTab(tab: Tab): Promise<boolean> {
    if (tab.dirty) {
      this.activate(tab);
      const choice = await askToSave(this.titleOf(tab));
      if (choice === "cancel") return false;
      if (choice === "save" && !(await this.saveTab(tab))) return false;
    }
    const index = this.tabs.indexOf(tab);
    if (index === -1) return false;
    this.tabs.splice(index, 1);
    this.pendingBuffers.delete(tab.id);
    void backend.deleteBuffer(tab.id).catch(() => {});

    // Como no Bloco de Notas: fechar a última aba fecha o aplicativo.
    if (!this.tabs.length) {
      await this.quit();
      return true;
    }
    if (this.active === tab) {
      this.active = null;
      this.activate(this.tabs[Math.min(index, this.tabs.length - 1)]);
    } else {
      this.renderTabs();
      this.scheduleFlush();
    }
    return true;
  }

  private titleOf(tab: Tab): string {
    if (tab.path) return basename(tab.path);
    const firstLine = tab.state.doc.line(1).text.trim();
    return firstLine ? firstLine.slice(0, 40) : "Sem título";
  }

  private onEditorUpdate(update: ViewUpdate) {
    const tab = this.active;
    if (!tab) return;
    tab.state = update.state;
    if (update.docChanged) {
      tab.dirty = !(tab.savedDoc && sameDoc(tab.savedDoc, update.state.doc));
      this.pendingBuffers.add(tab.id);
      this.renderTab(tab);
    }
    if (update.docChanged || update.selectionSet) {
      this.renderStatus();
      this.scheduleFlush();
    }
  }

  // -------------------------------------------------------------------------
  // Arquivos
  // -------------------------------------------------------------------------

  private async openWithDialog() {
    const picked = await nativeDialog(openDialog({ multiple: true, directory: false, title: "Abrir" }));
    if (!picked) return this.view.focus();
    await this.openFiles(Array.isArray(picked) ? picked : [picked]);
  }

  async openFiles(paths: string[]) {
    for (const path of paths) await this.openPath(path);
  }

  async openPending() {
    const paths = await backend.takePendingFiles().catch(() => []);
    await this.openFiles(paths);
  }

  private async openPath(path: string) {
    const existing = this.tabs.find((t) => t.path && samePath(t.path, path));
    if (existing) return this.activate(existing);

    let file;
    try {
      file = await backend.readTextFile(path);
    } catch (err) {
      await showMessage("Não foi possível abrir o arquivo", `${path}\n\n${err}`);
      return;
    }
    const tab = this.createTab({
      path,
      content: file.content,
      encoding: file.encoding,
      mtime: file.mtime,
    });

    // Uma aba vazia e sem nome é reaproveitada, como no Bloco de Notas.
    const current = this.active;
    if (current && !current.path && !current.dirty && current.state.doc.length === 0) {
      this.tabs[this.tabs.indexOf(current)] = tab;
      this.active = null;
      void backend.deleteBuffer(current.id).catch(() => {});
    } else {
      this.insertTab(tab);
    }
    this.activate(tab);
  }

  private suggestedFileName(tab: Tab): string {
    if (tab.path) return tab.path;
    const name = this.titleOf(tab).replace(/[\\/:*?"<>|]/g, "").trim();
    return `${name || "Sem título"}.txt`;
  }

  async saveTab(tab: Tab, saveAs = false): Promise<boolean> {
    let path = tab.path;
    if (!path || saveAs) {
      if (tab !== this.active) this.activate(tab);
      path = await nativeDialog(
        saveDialog({ title: saveAs ? "Salvar como" : "Salvar", defaultPath: this.suggestedFileName(tab) }),
      );
      if (!path) {
        this.view.focus();
        return false;
      }
    }
    const doc = tab.state.doc;
    try {
      tab.mtime = await backend.writeTextFile(
        path,
        doc.sliceString(0, doc.length, LINE_SEPARATORS[tab.lineEnding]),
        tab.encoding,
      );
    } catch (err) {
      await showMessage("Não foi possível salvar", `${path}\n\n${err}`);
      return false;
    }
    tab.path = path;
    tab.savedDoc = doc;
    // O usuário pode ter digitado enquanto o arquivo era gravado.
    tab.dirty = !sameDoc(doc, tab.state.doc);
    this.pendingBuffers.add(tab.id);
    this.renderTabs();
    this.renderStatus();
    this.scheduleFlush();
    return true;
  }

  private async saveAll() {
    for (const tab of [...this.tabs]) {
      if (tab.dirty && !(await this.saveTab(tab))) return;
    }
  }

  /** Recarrega abas sem alterações cujo arquivo mudou fora do app. */
  async checkExternalChanges() {
    for (const tab of [...this.tabs]) {
      if (!tab.path || tab.dirty || tab.mtime === null) continue;
      const mtime = await backend.fileMtime(tab.path).catch(() => null);
      if (mtime !== null && mtime !== tab.mtime) await this.reloadFromDisk(tab);
    }
  }

  private async reloadFromDisk(tab: Tab) {
    const file = await backend.readTextFile(tab.path!).catch(() => null);
    if (!file || tab.dirty) return;
    const { anchor, head } = tab.state.selection.main;
    const state = createEditorState(file.content, this.settings, (u) => this.onEditorUpdate(u), anchor, head);
    tab.state = state;
    tab.savedDoc = state.doc;
    tab.encoding = file.encoding;
    tab.lineEnding = detectLineEnding(file.content, tab.lineEnding);
    tab.mtime = file.mtime;
    if (tab === this.active) {
      const top = this.view.scrollDOM.scrollTop;
      this.view.setState(state);
      this.view.scrollDOM.scrollTop = top;
      this.renderStatus();
    }
    this.pendingBuffers.add(tab.id);
    this.renderTab(tab);
    this.scheduleFlush();
  }

  private async chooseEncoding() {
    const tab = this.active;
    if (!tab) return;
    const choice = await popupMenu(
      this.statusEncoding,
      (Object.keys(ENCODING_LABELS) as Encoding[]).map((value) => ({
        value,
        label: ENCODING_LABELS[value],
        checked: value === tab.encoding,
      })),
    );
    if (choice && choice !== tab.encoding) {
      tab.encoding = choice;
      this.markFormatChanged(tab);
    }
    this.view.focus();
  }

  private async chooseLineEnding() {
    const tab = this.active;
    if (!tab) return;
    const choice = await popupMenu(
      this.statusEol,
      (Object.keys(LINE_ENDING_LABELS) as LineEnding[]).map((value) => ({
        value,
        label: LINE_ENDING_LABELS[value],
        checked: value === tab.lineEnding,
      })),
    );
    if (choice && choice !== tab.lineEnding) {
      tab.lineEnding = choice;
      this.markFormatChanged(tab);
    }
    this.view.focus();
  }

  /** Mudar codificação ou quebra de linha altera o arquivo no disco. */
  private markFormatChanged(tab: Tab) {
    if (tab.path) {
      tab.savedDoc = null;
      tab.dirty = true;
      this.pendingBuffers.add(tab.id);
    }
    this.renderTab(tab);
    this.renderStatus();
    this.scheduleFlush();
  }

  // -------------------------------------------------------------------------
  // Sessão
  // -------------------------------------------------------------------------

  async restore() {
    let session: Session | null = null;
    try {
      const raw = await backend.loadSession();
      if (raw) session = JSON.parse(raw) as Session;
    } catch (err) {
      console.error("Sessão ilegível; começando do zero", err);
    }

    if (session?.version === 1) {
      this.settings = { ...DEFAULT_SETTINGS, ...session.settings };
      for (const saved of session.tabs) {
        const tab = await this.restoreTab(saved);
        if (tab) this.tabs.push(tab);
      }
    }
    this.applySettings();
    await backend.pruneBuffers(this.tabs.map((t) => t.id)).catch(() => {});
    if (!this.tabs.length) this.tabs.push(this.createTab({}));
    this.activate(this.tabs.find((t) => t.id === session?.activeId) ?? this.tabs[0]);
  }

  private async restoreTab(saved: SessionTab): Promise<Tab | null> {
    const base: TabInit = {
      id: saved.id,
      path: saved.path,
      encoding: saved.encoding,
      lineEnding: saved.lineEnding,
      mtime: saved.mtime,
      anchor: saved.anchor,
      head: saved.head,
      scrollTop: saved.scrollTop,
    };
    const fromDisk = async () => {
      const file = await backend.readTextFile(saved.path!);
      return this.createTab({
        ...base,
        content: file.content,
        encoding: file.encoding,
        mtime: file.mtime,
        lineEnding: detectLineEnding(file.content, saved.lineEnding),
      });
    };

    // Arquivo salvo e sem alterações: o disco é a fonte da verdade.
    if (saved.path && !saved.dirty) {
      try {
        return await fromDisk();
      } catch {
        // O arquivo sumiu; usa a cópia da sessão, se houver.
        const buffer = await backend.loadBuffer(saved.id).catch(() => null);
        return buffer === null ? null : this.createTab({ ...base, content: buffer, dirty: true });
      }
    }

    const buffer = await backend.loadBuffer(saved.id).catch(() => null);
    if (buffer !== null) return this.createTab({ ...base, content: buffer, dirty: saved.dirty });
    if (saved.path) return fromDisk().catch(() => null);
    return this.createTab(base);
  }

  private serialize(): Session {
    return {
      version: 1,
      activeId: this.active?.id ?? null,
      settings: this.settings,
      tabs: this.tabs.map((t) => ({
        id: t.id,
        path: t.path,
        encoding: t.encoding,
        lineEnding: t.lineEnding,
        mtime: t.mtime,
        dirty: t.dirty,
        anchor: t.state.selection.main.anchor,
        head: t.state.selection.main.head,
        scrollTop: Math.round(t.scrollTop),
      })),
    };
  }

  private scheduleFlush() {
    if (this.flushTimer === undefined) {
      this.flushTimer = window.setTimeout(() => void this.flush(), FLUSH_DELAY);
    }
  }

  /** Grava o conteúdo das abas alteradas e o estado da sessão. */
  flush(): Promise<void> {
    window.clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.active) {
      this.active.state = this.view.state;
      this.active.scrollTop = this.view.scrollDOM.scrollTop;
    }
    const buffers = [...this.pendingBuffers].flatMap((id) => {
      const tab = this.tabs.find((t) => t.id === id);
      return tab ? [{ id, content: tab.state.doc.toString() }] : [];
    });
    this.pendingBuffers.clear();
    const session = JSON.stringify(this.serialize());

    // Em fila, para duas gravações nunca disputarem o mesmo arquivo.
    this.flushChain = this.flushChain
      .then(async () => {
        for (const { id, content } of buffers) await backend.saveBuffer(id, content);
        await backend.saveSession(session);
      })
      .catch((err) => console.error("Falha ao salvar a sessão", err));
    return this.flushChain;
  }

  async quit() {
    await this.flush();
    await backend.quit();
  }

  // -------------------------------------------------------------------------
  // Configurações e zoom
  // -------------------------------------------------------------------------

  updateSettings(patch: Partial<Settings>) {
    const before = this.settings;
    this.settings = { ...before, ...patch };
    if (before.wordWrap !== this.settings.wordWrap || before.spellcheck !== this.settings.spellcheck) {
      this.view.dispatch({ effects: optionEffects(this.settings) });
    }
    this.applySettings();
    this.renderStatus();
    this.scheduleFlush();
  }

  private applySettings() {
    document.documentElement.style.setProperty("--font-size", `${(BASE_FONT_SIZE * this.settings.zoom) / 100}px`);
    this.statusBar.hidden = !this.settings.statusBar;
    this.view.requestMeasure();
    this.onSettingsChange();
  }

  private setZoom(zoom: number) {
    this.updateSettings({ zoom: Math.max(10, Math.min(500, Math.round(zoom / 10) * 10)) });
  }

  /** Ctrl/Cmd + roda do mouse, ou gesto de pinça no trackpad. */
  private onZoomWheel(e: WheelEvent) {
    if (!e.ctrlKey && !(isMac && e.metaKey)) return;
    e.preventDefault();
    this.zoomDelta -= e.deltaY;
    if (Math.abs(this.zoomDelta) >= 40) {
      this.setZoom(this.settings.zoom + Math.sign(this.zoomDelta) * 10);
      this.zoomDelta = 0;
    }
  }

  // -------------------------------------------------------------------------
  // Interface
  // -------------------------------------------------------------------------

  private renderTabs() {
    const alive = new Set(this.tabs.map((t) => t.id));
    for (const [id, el] of this.tabEls) {
      if (!alive.has(id)) {
        el.remove();
        this.tabEls.delete(id);
      }
    }
    this.tabs.forEach((tab, i) => {
      const el = this.tabEls.get(tab.id) ?? this.createTabElement(tab);
      if (this.tabStrip.children[i] !== el) this.tabStrip.insertBefore(el, this.tabStrip.children[i] ?? null);
      this.renderTab(tab);
    });
  }

  private renderTab(tab: Tab) {
    const el = this.tabEls.get(tab.id);
    if (!el) return;
    const title = this.titleOf(tab);
    const label = el.firstElementChild!;
    if (label.textContent !== title) label.textContent = title;
    el.title = tab.path ?? title;
    el.classList.toggle("active", tab === this.active);
    el.classList.toggle("dirty", tab.dirty);
    el.setAttribute("aria-selected", String(tab === this.active));
    if (tab === this.active) this.updateWindowTitle();
  }

  private createTabElement(tab: Tab): HTMLElement {
    const el = document.createElement("div");
    el.className = "tab";
    el.dataset.id = tab.id;
    el.setAttribute("role", "tab");

    const label = document.createElement("span");
    label.className = "title";
    const close = document.createElement("button");
    close.className = "close";
    close.title = "Fechar aba";
    close.tabIndex = -1;
    close.addEventListener("pointerdown", (e) => e.stopPropagation());
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.closeTab(tab);
    });

    // Sem isto o clique tira o foco do editor.
    el.addEventListener("mousedown", (e) => e.preventDefault());
    el.addEventListener("pointerdown", (e) => this.onTabPointerDown(e, tab, el));
    el.addEventListener("auxclick", (e) => {
      if (e.button === 1) {
        e.preventDefault();
        void this.closeTab(tab);
      }
    });

    el.append(label, close);
    this.tabEls.set(tab.id, el);
    return el;
  }

  /** Clique ativa a aba; arrastar para os lados muda a ordem. */
  private onTabPointerDown(e: PointerEvent, tab: Tab, el: HTMLElement) {
    if (e.button === 1) e.preventDefault();
    if (e.button !== 0) return;
    this.activate(tab);

    const startX = e.clientX;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging) {
        if (Math.abs(ev.clientX - startX) < 6) return;
        dragging = true;
        el.classList.add("dragging");
      }
      const strip = this.tabStrip.getBoundingClientRect();
      const target = document
        .elementFromPoint(ev.clientX, strip.bottom - 12)
        ?.closest<HTMLElement>(".tab");
      if (!target || target === el) return;
      const to = this.tabs.findIndex((t) => t.id === target.dataset.id);
      const from = this.tabs.indexOf(tab);
      if (to < 0 || from < 0) return;
      this.tabs.splice(from, 1);
      this.tabs.splice(to, 0, tab);
      this.renderTabs();
      this.scheduleFlush();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      el.classList.remove("dragging");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  private renderStatus() {
    const tab = this.active;
    if (!tab) return;
    const { state } = this.view;
    const cursor = state.selection.main.head;
    const line = state.doc.lineAt(cursor);
    this.statusPos.textContent = `Ln ${formatNumber(line.number)}, Col ${formatNumber(cursor - line.from + 1)}`;

    const total = state.doc.length;
    const selected = state.selection.ranges.reduce((n, r) => n + r.to - r.from, 0);
    this.statusChars.textContent = selected
      ? `${formatNumber(selected)} de ${formatNumber(total)} caracteres`
      : `${formatNumber(total)} ${total === 1 ? "caractere" : "caracteres"}`;
    this.statusZoom.textContent = `${this.settings.zoom}%`;
    this.statusEol.textContent = LINE_ENDING_LABELS[tab.lineEnding];
    this.statusEncoding.textContent = ENCODING_LABELS[tab.encoding];
  }

  private updateWindowTitle() {
    const tab = this.active;
    const title = tab ? `${tab.dirty ? "*" : ""}${this.titleOf(tab)} - ${APP_NAME}` : APP_NAME;
    if (title === this.windowTitle) return;
    this.windowTitle = title;
    document.title = title;
    try {
      void getCurrentWindow()
        .setTitle(title)
        .catch(() => {});
    } catch {
      // Fora do Tauri (pré-visualização no navegador).
    }
  }
}
