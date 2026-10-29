# Bloco de Notas

Bloco de notas leve para macOS, inspirado no Bloco de Notas do Windows 11.
Feito com [Tauri 2](https://tauri.app) (Rust + WebKit do sistema) e
[CodeMirror 6](https://codemirror.net).

## O que já faz

- **Abas**, com reordenação arrastando e Cmd+1…9 para trocar.
- **Sessão persistente**: o conteúdo de todas as abas, salvas ou não, é gravado
  automaticamente. Fechar o app não pergunta nada; ao abrir, tudo volta como
  estava (texto, cursor, rolagem, aba ativa).
- Pergunta se quer salvar só ao **fechar uma aba** alterada.
- Abrir, Salvar, Salvar como, Salvar tudo; arrastar arquivos para a janela;
  abrir pelo Finder ("Abrir com").
- Localizar, substituir, ir para a linha, data e hora (F5).
- Zoom (Cmd +/−/0 ou pinça no trackpad), quebra automática de linha,
  verificação ortográfica.
- Barra de status com linha/coluna, caracteres, zoom, quebra de linha
  (LF/CRLF/CR) e codificação (UTF-8, UTF-8 com BOM, UTF-16, ANSI), ambas
  clicáveis para trocar.
- Recarrega sozinho arquivos sem alterações que mudaram fora do app.
- Tema claro/escuro seguindo o sistema.

## Onde a sessão fica guardada

- macOS: `~/Library/Application Support/com.marcopolomoreno.bloconotas/session/`
- Windows: `%APPDATA%\com.marcopolomoreno.bloconotas\session\`

`session.json` guarda a lista de abas; `buffers/` tem o texto de cada aba.

## Pré-requisitos

- [Node.js](https://nodejs.org) 20 ou mais novo
- [Rust](https://rustup.rs) (`rustup`)
- No Windows: Ferramentas de Build do Visual Studio (C++) e WebView2 (já vem no Windows 11)
- No macOS: Xcode Command Line Tools (`xcode-select --install`)

## Desenvolvimento

```bash
npm install
npm run tauri dev
```

Roda também no Windows, o que permite desenvolver deste PC. No Windows o menu
aparece dentro da janela; no Mac ele usa a barra de menus do sistema.

## Gerar o app para macOS

Precisa ser feito num Mac:

```bash
npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

Sem Mac, use o GitHub: suba o projeto para um repositório e rode o workflow
**Build macOS** (`.github/workflows/build-macos.yml`) na aba Actions. O `.dmg`
fica disponível para download no final da execução.

O app não é assinado. Na primeira vez, no Mac, clique com o botão direito no
app → **Abrir**, ou rode `xattr -cr "/Applications/Bloco de Notas.app"`. Para
distribuir sem esse aviso é preciso uma conta Apple Developer (assinatura +
notarização).

## Estrutura

```
src/                 interface (TypeScript)
  app.ts             abas, sessão, arquivos, barra de status
  editor.ts          configuração do CodeMirror
  commands.ts        lista de comandos, menus e atalhos
  ui/menus.ts        menu nativo do Mac, menu HTML e teclado
  ui/dialogs.ts      caixas de diálogo e menus suspensos
src-tauri/           parte nativa (Rust)
  src/lib.rs         leitura/gravação de arquivos e da sessão
  tauri.conf.json    janela, ícones e associação de arquivos
```

Para trocar o nome do app, altere `productName` e `identifier` em
`src-tauri/tauri.conf.json` e `APP_NAME` em `src/platform.ts`.
