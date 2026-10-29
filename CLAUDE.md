# Bloco de Notas

Clone do Bloco de Notas do Windows 11 em Tauri 2 + TypeScript + Vite +
CodeMirror 6. O app é desenvolvido e usado no **Windows e no macOS**. Fale com
o usuário em português; comentários e mensagens de commit também em português.

## Comandos

- `npm install`, depois `npm run tauri dev` (Vite na porta 1420; feche o app de
  teste ao terminar).
- `npm run check`: checagem de tipos. Não há testes automatizados.
- App empacotado no Mac: `npm run tauri build -- --bundles app`, gerado em
  `src-tauri/target/release/bundle/macos/`. "Abrir com" pelo Finder e a
  associação de arquivos só funcionam assim.
- Se o Rust acabou de ser instalado, um terminal antigo não acha o `cargo`:
  `source "$HOME/.cargo/env"`.

## Estrutura

- `src/app.ts`: abas, sessão, arquivos, zoom e barra de status. `App.run` é o
  ponto único de execução de comandos (menu e teclado).
- `src/commands.ts`: menus, atalhos (`Mod` = Cmd no Mac, Ctrl no Windows).
- `src/ui/menus.ts`: menu nativo do Mac, menu HTML do Windows e o tratamento
  de teclado (`installKeyboard`, em fase de captura, antes do CodeMirror).
- `src/ui/dialogs.ts`: diálogos HTML e o controle de janelas nativas abertas.
- `src-tauri/src/lib.rs`: arquivos, codificações, sessão, instância única e o
  encerramento do Mac (`mac_quit`).
- `src-tauri/Info.plist`: mesclado pelo Tauri só no Mac (idioma pt-BR).
- Sessão: `~/Library/Application Support/com.marcopolomoreno.bloconotas/session/`
  no Mac e `%APPDATA%\com.marcopolomoreno.bloconotas\session\` no Windows.

## Cuidados Mac/Windows

- Código específico do Mac fica atrás de `isMac` (`src/platform.ts`) ou de
  `#[cfg(target_os = "macos")]`. Não quebre o Windows.
- No Mac, Cmd+tecla vai primeiro à página; o WKWebView só repassa ao menu
  nativo se a página não chamar `preventDefault`. Por isso cada atalho chega
  uma vez só (testado sem o filtro de 120 ms de `App.run`).
- No Mac a janela nativa de abrir/salvar não bloqueia a página: atalhos com Cmd
  vazam para o editor. Abra esses diálogos sempre com `nativeDialog(...)`.
- Encerrar pelo Dock ou ao desligar o Mac chama `terminate:` direto; `mac_quit`
  adia o encerramento até a interface gravar a sessão (evento `quit-requested`).
- Recortar/Copiar/Colar no Mac são itens nativos (`macNative`); o WebKit cuida
  da área de transferência.
- `trafficLightPosition` (tauri.conf.json) e `padding-left` de
  `body.mac #titlebar` (styles.css) andam juntos: mudar a altura da barra de
  abas exige reajustar os dois.
- O workflow `.github/workflows/build-macos.yml` gera o `.dmg` universal no
  GitHub (só roda manualmente ou com tag `v*`).
