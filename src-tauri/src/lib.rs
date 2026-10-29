use std::{
    fs,
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
    sync::Mutex,
    time::UNIX_EPOCH,
};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

/// Arquivos pedidos pelo sistema (Finder, "Abrir com", linha de comando)
/// que a interface ainda não abriu.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

#[derive(Serialize)]
struct TextFile {
    content: String,
    encoding: &'static str,
    mtime: Option<u64>,
}

const MAX_FILE_SIZE: u64 = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sessão: cada aba tem uma cópia do conteúdo em `session/buffers/<id>.txt` e
// `session/session.json` guarda a lista de abas, cursor, configurações etc.
// ---------------------------------------------------------------------------

fn session_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("session");
    fs::create_dir_all(dir.join("buffers")).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn buffer_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Err("identificador de aba inválido".into());
    }
    Ok(session_dir(app)?.join("buffers").join(format!("{id}.txt")))
}

/// Grava num arquivo temporário e renomeia, para que uma queda no meio da
/// gravação nunca deixe a sessão corrompida.
fn atomic_write(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    let mut file = fs::File::create(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&tmp, path)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
async fn load_session(app: AppHandle) -> Result<Option<String>, String> {
    read_optional(&session_dir(&app)?.join("session.json"))
}

#[tauri::command]
async fn save_session(app: AppHandle, json: String) -> Result<(), String> {
    atomic_write(&session_dir(&app)?.join("session.json"), json.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn load_buffer(app: AppHandle, id: String) -> Result<Option<String>, String> {
    read_optional(&buffer_path(&app, &id)?)
}

#[tauri::command]
async fn save_buffer(app: AppHandle, id: String, content: String) -> Result<(), String> {
    atomic_write(&buffer_path(&app, &id)?, content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_buffer(app: AppHandle, id: String) -> Result<(), String> {
    match fs::remove_file(buffer_path(&app, &id)?) {
        Err(e) if e.kind() != ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/// Apaga cópias de abas que não existem mais (por exemplo, após uma queda).
#[tauri::command]
async fn prune_buffers(app: AppHandle, keep: Vec<String>) -> Result<(), String> {
    let dir = session_dir(&app)?.join("buffers");
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let id = name.strip_suffix(".txt").unwrap_or("");
        if !keep.iter().any(|k| k == id) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Arquivos do usuário, com detecção e conversão de codificação.
// ---------------------------------------------------------------------------

fn mtime_of(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn decode_utf16(bytes: &[u8], little_endian: bool) -> String {
    let units = bytes.chunks_exact(2).map(|pair| {
        if little_endian {
            u16::from_le_bytes([pair[0], pair[1]])
        } else {
            u16::from_be_bytes([pair[0], pair[1]])
        }
    });
    char::decode_utf16(units)
        .map(|c| c.unwrap_or(char::REPLACEMENT_CHARACTER))
        .collect()
}

fn decode(bytes: &[u8]) -> (String, &'static str) {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return (String::from_utf8_lossy(rest).into_owned(), "utf-8-bom");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        return (decode_utf16(rest, true), "utf-16le");
    }
    if let Some(rest) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        return (decode_utf16(rest, false), "utf-16be");
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => (text.to_owned(), "utf-8"),
        // Arquivos antigos do Windows em português costumam ser ANSI.
        Err(_) => (
            encoding_rs::WINDOWS_1252
                .decode_without_bom_handling(bytes)
                .0
                .into_owned(),
            "windows-1252",
        ),
    }
}

fn encode(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    Ok(match encoding {
        "utf-8-bom" => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        "utf-16le" => [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect(),
        "utf-16be" => [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect(),
        "windows-1252" => {
            let (bytes, _, unmappable) = encoding_rs::WINDOWS_1252.encode(text);
            if unmappable {
                return Err("O texto tem caracteres que não existem em ANSI (Windows-1252). \
                            Mude a codificação para UTF-8 e salve de novo."
                    .into());
            }
            bytes.into_owned()
        }
        _ => text.as_bytes().to_vec(),
    })
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<TextFile, String> {
    let meta = fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        return Err("O caminho é uma pasta, não um arquivo.".into());
    }
    if meta.len() > MAX_FILE_SIZE {
        return Err("O arquivo é grande demais para abrir (limite de 256 MB).".into());
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    let (content, encoding) = decode(&bytes);
    Ok(TextFile {
        content,
        encoding,
        mtime: mtime_of(Path::new(&path)),
    })
}

#[tauri::command]
async fn write_text_file(path: String, content: String, encoding: String) -> Result<Option<u64>, String> {
    let bytes = encode(&content, &encoding)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(mtime_of(Path::new(&path)))
}

#[tauri::command]
async fn file_mtime(path: String) -> Option<u64> {
    mtime_of(Path::new(&path))
}

#[tauri::command]
fn take_pending_files(pending: State<PendingFiles>) -> Vec<String> {
    std::mem::take(&mut *pending.0.lock().unwrap())
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

/// Caminhos de arquivo passados na linha de comando (ex.: dois cliques num .txt no Windows).
fn paths_from_args(args: impl IntoIterator<Item = String>, cwd: &Path) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .map(|arg| cwd.join(arg).to_string_lossy().into_owned())
        .collect()
}

/// Entrega arquivos à interface, que os busca com `take_pending_files`.
fn queue_files(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<PendingFiles>().0.lock().unwrap().extend(paths);
    let _ = app.emit("open-files", ());
}

pub fn run() {
    let cwd = std::env::current_dir().unwrap_or_default();
    let from_args = paths_from_args(std::env::args(), &cwd);

    let app = tauri::Builder::default()
        // Precisa ser o primeiro plugin. Abrir o app de novo (ou um arquivo
        // pelo Explorer) manda os arquivos para a janela que já está aberta,
        // em vez de criar outra instância disputando a mesma sessão.
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            queue_files(app, paths_from_args(args, Path::new(&cwd)));
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(PendingFiles(Mutex::new(from_args)))
        .invoke_handler(tauri::generate_handler![
            load_session,
            save_session,
            load_buffer,
            save_buffer,
            delete_buffer,
            prune_buffers,
            read_text_file,
            write_text_file,
            file_mtime,
            take_pending_files,
            quit,
        ])
        .build(tauri::generate_context!())
        .expect("falha ao iniciar o aplicativo");

    app.run(|_app, _event| {
        // No macOS, arquivos abertos pelo Finder chegam por este evento,
        // inclusive com o app já aberto.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            let paths = urls
                .into_iter()
                .filter_map(|url| url.to_file_path().ok())
                .map(|path| path.to_string_lossy().into_owned())
                .collect();
            queue_files(_app, paths);
        }
    });
}
