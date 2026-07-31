use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};
use tauri_plugin_crunchymurmur_transcribe::PluginConfig;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

const PARAKEET_ID: &str = "parakeet-v3";
const PARAKEET_DIRECTORY: &str = "parakeet-tdt-0.6b-v3-int8";
const SOURCE_ROOT: &str = "https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main";

struct ModelFile {
    path: &'static str,
    bytes: u64,
    sha256: &'static str,
}

const MODEL_FILES: &[ModelFile] = &[
    ModelFile {
        path: "encoder-model.int8.onnx",
        bytes: 652_183_999,
        sha256: "6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09",
    },
    ModelFile {
        path: "decoder_joint-model.int8.onnx",
        bytes: 18_202_004,
        sha256: "eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70",
    },
    ModelFile {
        path: "nemo128.onnx",
        bytes: 139_764,
        sha256: "a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f",
    },
    ModelFile {
        path: "vocab.txt",
        bytes: 93_939,
        sha256: "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d",
    },
    ModelFile {
        path: "config.json",
        bytes: 97,
        sha256: "666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466",
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicModel {
    id: String,
    engine: &'static str,
    name: String,
    description: String,
    bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Bootstrap {
    models: Vec<PublicModel>,
    platform: &'static str,
    default_shortcut: &'static str,
    groq_configured: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelProgress {
    bytes_done: u64,
    bytes_total: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InstallResult {
    selected_model_id: &'static str,
    models: Vec<PublicModel>,
}

struct DemoState {
    model_root: PathBuf,
    shortcut: Mutex<String>,
}

fn model_root() -> PathBuf {
    dirs::config_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("CrunchyMurmur")
        .join("Models")
}

fn expected_manifest() -> Value {
    json!({
        "schemaVersion": 1,
        "modelId": "parakeet-v3",
        "modelVersion": "1.0.0",
        "engine": "parakeet",
        "quantisation": "int8",
        "languages": [
            "auto", "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr",
            "de", "el", "hu", "it", "lv", "lt", "mt", "pl", "pt", "ro",
            "sk", "sl", "es", "sv", "ru", "uk"
        ],
        "files": MODEL_FILES.iter().map(|file| json!({
            "path": file.path,
            "bytes": file.bytes,
            "sha256": file.sha256
        })).collect::<Vec<_>>(),
        "minimumEngineVersion": "0.1.0"
    })
}

fn generated_manifest() -> Vec<u8> {
    let mut contents =
        serde_json::to_string_pretty(&expected_manifest()).expect("known manifest serializes");
    contents.push('\n');
    contents.into_bytes()
}

fn trusted_manifest(model_directory: &Path) -> (String, Vec<u8>) {
    let manifest_path = model_directory.join("crunchymurmur-model.json");
    let contents = fs::read(&manifest_path)
        .ok()
        .filter(|contents| {
            serde_json::from_slice::<Value>(contents)
                .is_ok_and(|candidate| candidate == expected_manifest())
        })
        .unwrap_or_else(generated_manifest);
    (hex_digest(&contents), contents)
}

fn hex_digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn parakeet_ready(root: &Path) -> bool {
    let directory = root.join(PARAKEET_DIRECTORY);
    MODEL_FILES.iter().all(|file| {
        fs::metadata(directory.join(file.path))
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() == file.bytes)
    }) && fs::read(directory.join("crunchymurmur-model.json"))
        .ok()
        .and_then(|contents| serde_json::from_slice::<Value>(&contents).ok())
        .is_some_and(|manifest| manifest == expected_manifest())
}

fn whisper_models(root: &Path) -> Vec<(PublicModel, PathBuf)> {
    let mut models = Vec::new();
    let Ok(entries) = fs::read_dir(root) else {
        return models;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if !name.starts_with("ggml-") || !name.ends_with(".bin") {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() || metadata.len() < 1024 * 1024 {
            continue;
        }
        let model_name = &name["ggml-".len()..name.len() - ".bin".len()];
        let friendly = match model_name {
            "tiny.en" => "Whisper Tiny English".into(),
            "base" => "Whisper Base".into(),
            "small" => "Whisper Small".into(),
            "medium" => "Whisper Medium".into(),
            "large-v3-turbo-q5_0" => "Whisper Large V3 Turbo (Q5)".into(),
            "large-v3-turbo" => "Whisper Large V3 Turbo".into(),
            "large-v3" => "Whisper Large V3".into(),
            other => format!("Whisper {other}"),
        };
        models.push((
            PublicModel {
                id: format!("whisper:{model_name}"),
                engine: "whisper",
                name: friendly,
                description: String::new(),
                bytes: metadata.len(),
            },
            path,
        ));
    }
    models.sort_by(|left, right| left.0.id.cmp(&right.0.id));
    models
}

fn public_models(root: &Path) -> Vec<PublicModel> {
    let mut models = Vec::new();
    if parakeet_ready(root) {
        models.push(PublicModel {
            id: PARAKEET_ID.into(),
            engine: "parakeet",
            name: "Parakeet V3".into(),
            description: String::new(),
            bytes: MODEL_FILES.iter().map(|file| file.bytes).sum(),
        });
    }
    models.extend(whisper_models(root).into_iter().map(|(model, _)| model));
    models
}

#[tauri::command]
fn demo_bootstrap(state: State<'_, DemoState>) -> Bootstrap {
    Bootstrap {
        models: public_models(&state.model_root),
        platform: if cfg!(target_os = "windows") {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        },
        default_shortcut: if cfg!(target_os = "macos") {
            "Command+Shift+D"
        } else {
            "Control+Shift+D"
        },
        groq_configured: false,
    }
}

#[tauri::command]
async fn install_model(
    app: AppHandle,
    state: State<'_, DemoState>,
) -> Result<InstallResult, String> {
    let root = state.model_root.clone();
    tauri::async_runtime::spawn_blocking(move || install_parakeet(&app, &root))
        .await
        .map_err(|_| "The model installation task did not complete.".to_string())?
}

fn install_parakeet(app: &AppHandle, root: &Path) -> Result<InstallResult, String> {
    if parakeet_ready(root) {
        return Ok(InstallResult {
            selected_model_id: PARAKEET_ID,
            models: public_models(root),
        });
    }
    fs::create_dir_all(root).map_err(|_| "The model directory could not be created.")?;
    let final_directory = root.join(PARAKEET_DIRECTORY);
    let staging = root.join(format!(".{PARAKEET_DIRECTORY}.partial"));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging)
        .map_err(|_| "The model staging directory could not be created.")?;
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|_| "The model download client could not be created.")?;
    let total: u64 = MODEL_FILES.iter().map(|file| file.bytes).sum();
    let mut completed = 0_u64;
    let result = (|| {
        for file in MODEL_FILES {
            let mut response = client
                .get(format!("{SOURCE_ROOT}/{}", file.path))
                .send()
                .map_err(|_| format!("Could not download {}.", file.path))?
                .error_for_status()
                .map_err(|_| format!("Could not download {}.", file.path))?;
            let destination = staging.join(file.path);
            let mut output =
                fs::File::create(&destination).map_err(|_| "A model file could not be created.")?;
            let mut digest = Sha256::new();
            let mut received = 0_u64;
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = response
                    .read(&mut buffer)
                    .map_err(|_| "The model download was interrupted.")?;
                if read == 0 {
                    break;
                }
                output
                    .write_all(&buffer[..read])
                    .map_err(|_| "A model file could not be written.")?;
                digest.update(&buffer[..read]);
                received += read as u64;
                completed += read as u64;
                let _ = app.emit(
                    "model-progress",
                    ModelProgress {
                        bytes_done: completed,
                        bytes_total: total,
                    },
                );
            }
            if received != file.bytes || format!("{:x}", digest.finalize()) != file.sha256 {
                return Err(format!("Verification failed for {}.", file.path));
            }
        }
        fs::write(
            staging.join("crunchymurmur-model.json"),
            generated_manifest(),
        )
        .map_err(|_| "The model manifest could not be written.")?;
        if final_directory.exists() {
            fs::remove_dir_all(&final_directory)
                .map_err(|_| "The old model directory could not be replaced.")?;
        }
        fs::rename(&staging, &final_directory)
            .map_err(|_| "The verified model could not be installed.")?;
        Ok(InstallResult {
            selected_model_id: PARAKEET_ID,
            models: public_models(root),
        })
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    state: State<'_, DemoState>,
    accelerator: String,
) -> Result<String, String> {
    let requested = if accelerator == "Control+Super"
        || accelerator == "Control+Shift+Space"
        || accelerator == "Command+Shift+Space"
    {
        if cfg!(target_os = "macos") {
            "Command+Shift+D".to_string()
        } else {
            "Control+Shift+D".to_string()
        }
    } else {
        accelerator
    };
    let native = requested
        .replace("Control", "Ctrl")
        .replace("Command", "Super");
    app.global_shortcut()
        .unregister_all()
        .map_err(|error| error.to_string())?;
    app.global_shortcut()
        .register(native.as_str())
        .map_err(|error| error.to_string())?;
    *state
        .shortcut
        .lock()
        .map_err(|_| "Shortcut state is unavailable.")? = requested.clone();
    Ok(requested)
}

fn runtime_paths() -> (Option<PathBuf>, Option<PathBuf>) {
    let architecture = match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    };
    let folder = if cfg!(target_os = "macos") {
        "mac-universal".to_string()
    } else {
        format!(
            "{}-{architecture}",
            if cfg!(target_os = "windows") {
                "win"
            } else {
                "linux"
            }
        )
    };
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("build")
        .join("whisper-runtime")
        .join(folder);
    let executable = |base: &str| {
        root.join(if cfg!(target_os = "windows") {
            format!("{base}.exe")
        } else {
            base.to_string()
        })
    };
    (
        Some(executable("whisper-cli")),
        Some(executable("whisper-server")),
    )
}

fn main() {
    let models = model_root();
    let parakeet_directory = models.join(PARAKEET_DIRECTORY);
    let (manifest_digest, _) = trusted_manifest(&parakeet_directory);
    let (whisper_cli, whisper_server) = runtime_paths();
    let mut transcription = PluginConfig::new()
        .register_parakeet_model(PARAKEET_ID, parakeet_directory, manifest_digest)
        .whisper_runtime(whisper_cli, whisper_server)
        .enable_groq();
    for (model, model_path) in whisper_models(&models) {
        transcription = transcription.register_whisper_model(model.id, model_path);
    }

    tauri::Builder::default()
        .manage(DemoState {
            model_root: models,
            shortcut: Mutex::new(String::new()),
        })
        .plugin(tauri_plugin_crunchymurmur_transcribe::init(transcription))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = app.emit("shortcut-action", "toggle");
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            demo_bootstrap,
            install_model,
            set_shortcut
        ])
        .run(tauri::generate_context!())
        .expect("failed to run the CrunchyMurmur Tauri SDK chat demo");
}
