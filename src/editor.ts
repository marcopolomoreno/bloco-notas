import { Compartment, EditorSelection, EditorState, type StateEffect } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
  type ViewUpdate,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentLess, insertTab } from "@codemirror/commands";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";

export interface EditorOptions {
  wordWrap: boolean;
  spellcheck: boolean;
}

const wrapping = new Compartment();
const spelling = new Compartment();

const wrapExtension = (on: boolean) => (on ? EditorView.lineWrapping : []);
const spellExtension = (on: boolean) =>
  EditorView.contentAttributes.of({
    spellcheck: on ? "true" : "false",
    autocorrect: "off",
    autocapitalize: "off",
  });

/** Efeitos que aplicam as opções atuais a um estado criado antes delas mudarem. */
export function optionEffects(options: EditorOptions): StateEffect<unknown>[] {
  return [
    wrapping.reconfigure(wrapExtension(options.wordWrap)),
    spelling.reconfigure(spellExtension(options.spellcheck)),
  ];
}

const phrases = EditorState.phrases.of({
  Find: "Localizar",
  Replace: "Substituir",
  next: "próxima",
  previous: "anterior",
  all: "todas",
  "match case": "diferenciar maiúsculas",
  regexp: "expressão regular",
  "by word": "palavra inteira",
  replace: "substituir",
  "replace all": "substituir tudo",
  close: "fechar",
  "current match": "ocorrência atual",
  "on line": "na linha",
  "replaced match on line $": "ocorrência substituída na linha $",
  "replaced $ matches": "$ ocorrências substituídas",
  "Go to line": "Ir para a linha",
  go: "ir",
});

const theme = EditorView.theme({
  "&": { height: "100%", color: "var(--fg)", backgroundColor: "var(--bg-editor)" },
  ".cm-scroller": {
    fontFamily: "var(--mono-font)",
    fontSize: "var(--font-size)",
    lineHeight: "1.5",
  },
  ".cm-content": { padding: "10px 0", caretColor: "var(--fg)" },
  ".cm-line": { padding: "0 16px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--fg)", borderLeftWidth: "1.5px" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--selection)" },
  ".cm-selectionMatch": { backgroundColor: "var(--match)" },
  ".cm-searchMatch": { backgroundColor: "var(--match)", outline: "1px solid var(--match-border)" },
  ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "var(--selection)" },
  ".cm-panels": {
    backgroundColor: "var(--bg-chrome)",
    color: "var(--fg)",
    fontFamily: "var(--ui-font)",
  },
  ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
  ".cm-panel.cm-search, .cm-panel.cm-gotoLine": { padding: "8px 40px 8px 12px", fontSize: "13px" },
  ".cm-textfield": {
    font: "inherit",
    color: "var(--fg)",
    backgroundColor: "var(--bg-editor)",
    border: "1px solid var(--control-border)",
    borderRadius: "4px",
    padding: "3px 6px",
  },
  ".cm-textfield:focus": { outline: "none", borderBottom: "2px solid var(--accent)" },
  ".cm-button": {
    font: "inherit",
    color: "var(--fg)",
    backgroundImage: "none",
    backgroundColor: "var(--control-bg)",
    border: "1px solid var(--control-border)",
    borderRadius: "4px",
    padding: "3px 10px",
  },
  ".cm-button:hover": { backgroundColor: "var(--control-hover)" },
  ".cm-panel label": { fontSize: "12px", color: "var(--fg-muted)" },
  ".cm-panel button[name=close]": { color: "var(--fg-muted)", fontSize: "18px", right: "10px", top: "6px" },
});

/** Cria o estado do editor de uma aba (texto, cursor e histórico de desfazer). */
export function createEditorState(
  content: string,
  options: EditorOptions,
  onUpdate: (update: ViewUpdate) => void,
  anchor = 0,
  head = anchor,
): EditorState {
  const state = EditorState.create({
    doc: content,
    extensions: [
      history(),
      drawSelection(),
      dropCursor(),
      highlightSpecialChars(),
      rectangularSelection(),
      highlightSelectionMatches(),
      search({ top: true }),
      EditorState.allowMultipleSelections.of(true),
      keymap.of([
        { key: "Tab", run: insertTab, shift: indentLess },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      wrapping.of(wrapExtension(options.wordWrap)),
      spelling.of(spellExtension(options.spellcheck)),
      phrases,
      theme,
      EditorView.updateListener.of(onUpdate),
    ],
  });
  if (anchor === 0 && head === 0) return state;
  const clamp = (pos: number) => Math.max(0, Math.min(pos, state.doc.length));
  return state.update({ selection: EditorSelection.single(clamp(anchor), clamp(head)) }).state;
}
