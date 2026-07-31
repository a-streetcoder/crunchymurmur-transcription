use crate::{
    AudioInput, Diagnostics, EngineInformation, Outcome, PrepareOptions, TranscribeOptions,
    TranscriberService, Transcript, TranscriptionError, TranscriptionErrorCode, milliseconds,
    resolve_allowed_audio_path,
};
use reqwest::blocking::{Client, multipart};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
const GROQ_ENDPOINT: &str = "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_TURBO: &str = "whisper-large-v3-turbo";
const GROQ_LARGE: &str = "whisper-large-v3";

#[derive(Debug, Clone)]
pub(crate) struct ParakeetRegistration {
    pub directory: PathBuf,
    pub trusted_manifest_sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct WhisperRegistration {
    pub model_path: PathBuf,
}

/// Provider configuration selected by a trusted Tauri window.
///
/// Local paths and trust material are resolved from the host-owned registry.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPrepareOptions {
    pub provider: ProviderKind,
    pub model_id: String,
    #[serde(default)]
    pub api_key: String,
}

/// Transcription implementations supported by the Tauri desktop adapter.
#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind {
    Parakeet,
    Whisper,
    Groq,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub(crate) enum CommandPrepareOptions {
    Provider(ProviderPrepareOptions),
    Legacy(PrepareOptions),
}

enum ActiveProvider {
    None,
    Parakeet(TranscriberService),
    Whisper(WhisperBackend),
    Groq(GroqBackend),
}

/// Provider-aware implementation behind the Tauri plugin's four-method interface.
pub(crate) struct ProviderTranscriberService {
    allowed_audio_roots: Vec<PathBuf>,
    parakeet_profiles: HashMap<String, ParakeetRegistration>,
    whisper_profiles: HashMap<String, WhisperRegistration>,
    whisper_cli_path: Option<PathBuf>,
    whisper_server_path: Option<PathBuf>,
    groq_enabled: bool,
    groq_api_key: String,
    active: ActiveProvider,
}

impl ProviderTranscriberService {
    pub(crate) fn new(
        allowed_audio_roots: Vec<PathBuf>,
        parakeet_profiles: HashMap<String, ParakeetRegistration>,
        whisper_profiles: HashMap<String, WhisperRegistration>,
        whisper_cli_path: Option<PathBuf>,
        whisper_server_path: Option<PathBuf>,
        groq_enabled: bool,
    ) -> Self {
        Self {
            allowed_audio_roots,
            parakeet_profiles,
            whisper_profiles,
            whisper_cli_path,
            whisper_server_path,
            groq_enabled,
            groq_api_key: String::new(),
            active: ActiveProvider::None,
        }
    }

    pub(crate) fn prepare(
        &mut self,
        options: CommandPrepareOptions,
    ) -> Result<EngineInformation, TranscriptionError> {
        match options {
            CommandPrepareOptions::Legacy(options) => {
                let mut service =
                    TranscriberService::with_audio_roots(self.allowed_audio_roots.clone());
                let information = service.prepare(options)?;
                self.dispose_active();
                self.active = ActiveProvider::Parakeet(service);
                Ok(information)
            }
            CommandPrepareOptions::Provider(options) => self.prepare_provider(options),
        }
    }

    fn prepare_provider(
        &mut self,
        options: ProviderPrepareOptions,
    ) -> Result<EngineInformation, TranscriptionError> {
        let model_id = options.model_id.trim();
        if model_id.is_empty() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::ModelNotFound,
                "A registered transcription model is required.",
                true,
            ));
        }
        match options.provider {
            ProviderKind::Parakeet => {
                let registration = self.parakeet_profiles.get(model_id).ok_or_else(|| {
                    TranscriptionError::new(
                        TranscriptionErrorCode::ModelNotFound,
                        "The selected Parakeet model is not registered by the host.",
                        true,
                    )
                })?;
                let preparation = PrepareOptions {
                    model_directory: registration.directory.to_string_lossy().into_owned(),
                    trusted_manifest_sha256: registration.trusted_manifest_sha256.clone(),
                };
                if let ActiveProvider::Parakeet(service) = &mut self.active {
                    return service.prepare(preparation);
                }
                let mut service =
                    TranscriberService::with_audio_roots(self.allowed_audio_roots.clone());
                let information = service.prepare(preparation)?;
                self.dispose_active();
                self.active = ActiveProvider::Parakeet(service);
                Ok(information)
            }
            ProviderKind::Whisper => {
                let registration = self.whisper_profiles.get(model_id).ok_or_else(|| {
                    TranscriptionError::new(
                        TranscriptionErrorCode::ModelNotFound,
                        "The selected Whisper model is not registered by the host.",
                        true,
                    )
                })?;
                if let ActiveProvider::Whisper(backend) = &self.active
                    && backend.model_id == model_id
                {
                    return Ok(backend.information(true));
                }
                let backend = WhisperBackend::prepare(
                    model_id.to_string(),
                    registration.model_path.clone(),
                    self.whisper_cli_path.clone(),
                    self.whisper_server_path.clone(),
                )?;
                let information = backend.information(false);
                self.dispose_active();
                self.active = ActiveProvider::Whisper(backend);
                Ok(information)
            }
            ProviderKind::Groq => {
                if !self.groq_enabled {
                    return Err(TranscriptionError::new(
                        TranscriptionErrorCode::ProviderDisabled,
                        "Groq transcription is disabled by the Tauri host.",
                        false,
                    ));
                }
                if let ActiveProvider::Groq(backend) = &self.active
                    && backend.model_id == model_id
                    && options.api_key.trim().is_empty()
                {
                    return Ok(backend.information(true));
                }
                let supplied_key = options.api_key.trim();
                let api_key = if supplied_key.is_empty() {
                    self.groq_api_key.clone()
                } else {
                    supplied_key.to_string()
                };
                let backend = GroqBackend::prepare(model_id.to_string(), api_key.clone())?;
                let information = backend.information(false);
                self.groq_api_key = api_key;
                self.dispose_active();
                self.active = ActiveProvider::Groq(backend);
                Ok(information)
            }
        }
    }

    pub(crate) fn transcribe(
        &mut self,
        input: AudioInput,
        options: TranscribeOptions,
    ) -> Result<Transcript, TranscriptionError> {
        let path = input.path.trim();
        if path.is_empty() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::AudioInvalid,
                "A local audio file path is required.",
                true,
            ));
        }
        match &mut self.active {
            ActiveProvider::None => Err(not_prepared()),
            ActiveProvider::Parakeet(service) => service.transcribe(input, options),
            ActiveProvider::Whisper(backend) => {
                let audio = resolve_allowed_audio_path(path, &self.allowed_audio_roots)?;
                backend.transcribe(&audio, &options)
            }
            ActiveProvider::Groq(backend) => {
                let audio = resolve_allowed_audio_path(path, &self.allowed_audio_roots)?;
                backend.transcribe(&audio, &options)
            }
        }
    }

    pub(crate) fn transcribe_audio(
        &mut self,
        audio: Vec<u8>,
        options: TranscribeOptions,
    ) -> Result<Transcript, TranscriptionError> {
        if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::AudioInvalid,
                "Recorded WAV audio must be between 1 byte and 25 MB.",
                true,
            ));
        }
        let mut temporary = tempfile::Builder::new()
            .prefix("crunchymurmur-tauri-")
            .suffix(".wav")
            .tempfile()
            .map_err(|_| internal("The temporary recording could not be created."))?;
        temporary
            .write_all(&audio)
            .map_err(|_| internal("The temporary recording could not be written."))?;
        match &mut self.active {
            ActiveProvider::None => Err(not_prepared()),
            ActiveProvider::Parakeet(service) => {
                service.transcribe_trusted_path(temporary.path(), options)
            }
            ActiveProvider::Whisper(backend) => backend.transcribe(temporary.path(), &options),
            ActiveProvider::Groq(backend) => backend.transcribe(temporary.path(), &options),
        }
    }

    pub(crate) fn diagnostics(&self) -> Diagnostics {
        match &self.active {
            ActiveProvider::None => Diagnostics::idle(),
            ActiveProvider::Parakeet(service) => service.diagnostics(),
            ActiveProvider::Whisper(backend) => backend.diagnostics(),
            ActiveProvider::Groq(backend) => backend.diagnostics(),
        }
    }

    pub(crate) fn dispose(&mut self) {
        self.dispose_active();
        self.groq_api_key.clear();
    }

    fn dispose_active(&mut self) {
        if let ActiveProvider::Parakeet(service) = &mut self.active {
            service.dispose();
        }
        self.active = ActiveProvider::None;
    }
}

impl Drop for ProviderTranscriberService {
    fn drop(&mut self) {
        self.dispose();
    }
}

struct WhisperBackend {
    model_id: String,
    model_path: PathBuf,
    cli_path: Option<PathBuf>,
    server_path: Option<PathBuf>,
    server: Option<WhisperServer>,
    last_load_ms: u64,
    last_inference_ms: Option<u64>,
}

struct WhisperServer {
    child: Child,
    endpoint: String,
}

impl Drop for WhisperServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl WhisperBackend {
    fn prepare(
        model_id: String,
        model_path: PathBuf,
        cli_path: Option<PathBuf>,
        server_path: Option<PathBuf>,
    ) -> Result<Self, TranscriptionError> {
        if !model_path.is_file() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::ModelNotFound,
                "The registered Whisper model was not found.",
                true,
            ));
        }
        let cli_path = cli_path.filter(|path| path.is_file());
        let server_path = server_path.filter(|path| path.is_file());
        if cli_path.is_none() && server_path.is_none() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::RuntimeMissing,
                "The Tauri host did not register a usable whisper.cpp runtime.",
                true,
            ));
        }
        let started = Instant::now();
        let server = server_path
            .as_ref()
            .and_then(|path| start_whisper_server(path, &model_path).ok());
        if server.is_none() && cli_path.is_none() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::EngineCrashed,
                "whisper-server could not be started and no CLI fallback is available.",
                true,
            ));
        }
        Ok(Self {
            model_id,
            model_path,
            cli_path,
            server_path,
            server,
            last_load_ms: milliseconds(started.elapsed().as_millis()),
            last_inference_ms: None,
        })
    }

    fn information(&self, reused: bool) -> EngineInformation {
        EngineInformation {
            engine_version: "whisper.cpp".into(),
            model_id: self.model_id.clone(),
            model_version: "ggml".into(),
            load_ms: self.last_load_ms,
            reused,
        }
    }

    fn diagnostics(&self) -> Diagnostics {
        Diagnostics {
            state: "ready",
            model_id: Some(self.model_id.clone()),
            model_version: Some("ggml".into()),
            last_load_ms: Some(self.last_load_ms),
            last_inference_ms: self.last_inference_ms,
        }
    }

    fn transcribe(
        &mut self,
        audio: &Path,
        options: &TranscribeOptions,
    ) -> Result<Transcript, TranscriptionError> {
        let started = Instant::now();
        let language = normalised_language(options);
        let text = if let Some(server) = &mut self.server {
            match whisper_server_transcribe(&server.endpoint, audio, &language) {
                Ok(text) => text,
                Err(error) if self.cli_path.is_some() => {
                    self.server = None;
                    whisper_cli_transcribe(
                        self.cli_path.as_deref().expect("CLI checked above"),
                        &self.model_path,
                        audio,
                        &language,
                    )
                    .map_err(|_| error)?
                }
                Err(error) => return Err(error),
            }
        } else if let Some(cli) = &self.cli_path {
            whisper_cli_transcribe(cli, &self.model_path, audio, &language)?
        } else if let Some(server_path) = &self.server_path {
            self.server = Some(start_whisper_server(server_path, &self.model_path)?);
            whisper_server_transcribe(
                &self.server.as_ref().expect("server just started").endpoint,
                audio,
                &language,
            )?
        } else {
            return Err(not_prepared());
        };
        let inference_ms = milliseconds(started.elapsed().as_millis());
        self.last_inference_ms = Some(inference_ms);
        Ok(transcript(text, inference_ms, &language))
    }
}

fn start_whisper_server(
    executable: &Path,
    model_path: &Path,
) -> Result<WhisperServer, TranscriptionError> {
    let port = TcpListener::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
        .and_then(|listener| listener.local_addr())
        .map(|address| address.port())
        .map_err(|_| internal("A local whisper-server port could not be reserved."))?;
    let endpoint = format!("http://127.0.0.1:{port}");
    let mut child = Command::new(executable)
        .args(whisper_server_arguments(model_path, port))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            TranscriptionError::new(
                TranscriptionErrorCode::EngineCrashed,
                "whisper-server could not be started.",
                true,
            )
        })?;
    let client = Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .map_err(|_| internal("The local Whisper client could not be created."))?;
    let deadline = Instant::now() + Duration::from_secs(120);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::EngineCrashed,
                "whisper-server exited during model loading.",
                true,
            ));
        }
        if client
            .get(format!("{endpoint}/health"))
            .send()
            .is_ok_and(|response| response.status().is_success())
        {
            return Ok(WhisperServer { child, endpoint });
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    Err(TranscriptionError::new(
        TranscriptionErrorCode::TimedOut,
        "whisper-server did not finish loading the model in time.",
        true,
    ))
}

fn whisper_server_transcribe(
    endpoint: &str,
    audio: &Path,
    language: &str,
) -> Result<String, TranscriptionError> {
    #[derive(Deserialize)]
    struct Response {
        #[serde(default)]
        text: String,
    }
    let form = multipart::Form::new()
        .file("file", audio)
        .map_err(|_| audio_invalid("The recorded audio could not be read."))?
        .text("language", language.to_string())
        .text("response_format", "json")
        .text("temperature", "0.0");
    let response = Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|_| internal("The local Whisper client could not be created."))?
        .post(format!("{endpoint}/inference"))
        .multipart(form)
        .send()
        .map_err(|_| {
            TranscriptionError::new(
                TranscriptionErrorCode::EngineCrashed,
                "The local whisper-server stopped responding.",
                true,
            )
        })?;
    if !response.status().is_success() {
        return Err(TranscriptionError::new(
            TranscriptionErrorCode::InferenceFailed,
            format!(
                "whisper-server returned HTTP {}.",
                response.status().as_u16()
            ),
            true,
        ));
    }
    response
        .json::<Response>()
        .map(|payload| payload.text.trim().to_string())
        .map_err(|_| {
            TranscriptionError::new(
                TranscriptionErrorCode::InferenceFailed,
                "whisper-server returned an invalid response.",
                true,
            )
        })
}

fn whisper_cli_transcribe(
    executable: &Path,
    model: &Path,
    audio: &Path,
    language: &str,
) -> Result<String, TranscriptionError> {
    let output = Command::new(executable)
        .args(whisper_cli_arguments(model, audio, language))
        .stdin(Stdio::null())
        .output()
        .map_err(|_| {
            TranscriptionError::new(
                TranscriptionErrorCode::EngineCrashed,
                "whisper-cli could not be started.",
                true,
            )
        })?;
    if !output.status.success() {
        return Err(TranscriptionError::new(
            TranscriptionErrorCode::InferenceFailed,
            format!("whisper-cli exited with status {}.", output.status),
            true,
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn whisper_thread_count() -> usize {
    thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .min(16)
}

fn whisper_server_arguments(model: &Path, port: u16) -> Vec<OsString> {
    vec![
        "--model".into(),
        model.as_os_str().to_owned(),
        "--threads".into(),
        whisper_thread_count().to_string().into(),
        "--host".into(),
        "127.0.0.1".into(),
        "--port".into(),
        port.to_string().into(),
    ]
}

fn whisper_cli_arguments(model: &Path, audio: &Path, language: &str) -> Vec<OsString> {
    vec![
        "-m".into(),
        model.as_os_str().to_owned(),
        "-f".into(),
        audio.as_os_str().to_owned(),
        "-l".into(),
        language.into(),
        "-t".into(),
        whisper_thread_count().to_string().into(),
        "-nt".into(),
        "--no-prints".into(),
    ]
}

struct GroqBackend {
    model_id: String,
    api_key: String,
    last_inference_ms: Option<u64>,
}

impl Drop for GroqBackend {
    fn drop(&mut self) {
        self.api_key.clear();
    }
}

impl GroqBackend {
    fn prepare(model_id: String, api_key: String) -> Result<Self, TranscriptionError> {
        if model_id != GROQ_TURBO && model_id != GROQ_LARGE {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::ModelInvalid,
                "The selected Groq transcription model is not supported.",
                true,
            ));
        }
        if api_key.is_empty() {
            return Err(TranscriptionError::new(
                TranscriptionErrorCode::AuthMissing,
                "A Groq API key is required.",
                true,
            ));
        }
        Ok(Self {
            model_id,
            api_key,
            last_inference_ms: None,
        })
    }

    fn information(&self, reused: bool) -> EngineInformation {
        EngineInformation {
            engine_version: "groq-audio-v1".into(),
            model_id: self.model_id.clone(),
            model_version: "hosted".into(),
            load_ms: 0,
            reused,
        }
    }

    fn diagnostics(&self) -> Diagnostics {
        Diagnostics {
            state: "ready",
            model_id: Some(self.model_id.clone()),
            model_version: Some("hosted".into()),
            last_load_ms: Some(0),
            last_inference_ms: self.last_inference_ms,
        }
    }

    fn transcribe(
        &mut self,
        audio: &Path,
        options: &TranscribeOptions,
    ) -> Result<Transcript, TranscriptionError> {
        #[derive(Deserialize)]
        struct Response {
            #[serde(default)]
            text: String,
        }
        let metadata = fs::metadata(audio)
            .map_err(|_| audio_invalid("The recorded audio could not be read."))?;
        if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_AUDIO_BYTES as u64 {
            return Err(audio_invalid(
                "Recorded audio must be a non-empty file no larger than 25 MB.",
            ));
        }
        let language = normalised_language(options);
        let mut form = multipart::Form::new()
            .file("file", audio)
            .map_err(|_| audio_invalid("The recorded audio could not be read."))?
            .text("model", self.model_id.clone())
            .text("response_format", "json")
            .text("temperature", "0");
        if language != "auto" {
            form = form.text("language", language.clone());
        }
        let started = Instant::now();
        let response = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|_| internal("The Groq client could not be created."))?
            .post(GROQ_ENDPOINT)
            .bearer_auth(&self.api_key)
            .multipart(form)
            .send()
            .map_err(|error| {
                if error.is_timeout() {
                    TranscriptionError::new(
                        TranscriptionErrorCode::TimedOut,
                        "Groq transcription timed out.",
                        true,
                    )
                } else {
                    TranscriptionError::new(
                        TranscriptionErrorCode::NetworkError,
                        "Groq could not be reached.",
                        true,
                    )
                }
            })?;
        match response.status().as_u16() {
            200..=299 => {}
            401 | 403 => {
                return Err(TranscriptionError::new(
                    TranscriptionErrorCode::AuthInvalid,
                    "The Groq API key was rejected.",
                    true,
                ));
            }
            413 => {
                return Err(audio_invalid(
                    "The audio file exceeds the Groq account limit.",
                ));
            }
            429 => {
                return Err(TranscriptionError::new(
                    TranscriptionErrorCode::RateLimited,
                    "Groq rate-limited the request. Try again shortly.",
                    true,
                ));
            }
            status => {
                return Err(TranscriptionError::new(
                    TranscriptionErrorCode::InferenceFailed,
                    format!("Groq transcription failed with HTTP {status}."),
                    true,
                ));
            }
        }
        let text = response
            .json::<Response>()
            .map_err(|_| {
                TranscriptionError::new(
                    TranscriptionErrorCode::InferenceFailed,
                    "Groq returned an invalid transcription response.",
                    true,
                )
            })?
            .text
            .trim()
            .to_string();
        let inference_ms = milliseconds(started.elapsed().as_millis());
        self.last_inference_ms = Some(inference_ms);
        Ok(transcript(text, inference_ms, &language))
    }
}

fn transcript(text: String, inference_ms: u64, language: &str) -> Transcript {
    Transcript {
        outcome: if text.is_empty() {
            Outcome::NoSpeech
        } else {
            Outcome::Speech
        },
        text,
        language: (language != "auto").then(|| language.to_string()),
        inference_ms,
    }
}

fn normalised_language(options: &TranscribeOptions) -> String {
    options
        .language
        .as_deref()
        .unwrap_or("auto")
        .trim()
        .to_ascii_lowercase()
}

fn not_prepared() -> TranscriptionError {
    TranscriptionError::new(
        TranscriptionErrorCode::ModelNotPrepared,
        "The transcription provider is not prepared.",
        true,
    )
}

fn audio_invalid(message: &str) -> TranscriptionError {
    TranscriptionError::new(TranscriptionErrorCode::AudioInvalid, message, true)
}

fn internal(message: &str) -> TranscriptionError {
    TranscriptionError::new(TranscriptionErrorCode::Internal, message, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(groq_enabled: bool) -> ProviderTranscriberService {
        ProviderTranscriberService::new(
            Vec::new(),
            HashMap::new(),
            HashMap::new(),
            None,
            None,
            groq_enabled,
        )
    }

    #[test]
    fn groq_requires_both_host_opt_in_and_session_credentials() {
        let options = || {
            CommandPrepareOptions::Provider(ProviderPrepareOptions {
                provider: ProviderKind::Groq,
                model_id: GROQ_TURBO.into(),
                api_key: String::new(),
            })
        };
        let disabled = service(false)
            .prepare(options())
            .expect_err("the host must explicitly enable Groq");
        assert_eq!(disabled.code(), TranscriptionErrorCode::ProviderDisabled);

        let missing_key = service(true)
            .prepare(options())
            .expect_err("Groq requires a key for the current session");
        assert_eq!(missing_key.code(), TranscriptionErrorCode::AuthMissing);
    }

    #[test]
    fn registered_whisper_models_are_validated_before_runtime_startup() {
        let mut profiles = HashMap::new();
        profiles.insert(
            "whisper:missing".into(),
            WhisperRegistration {
                model_path: PathBuf::from("guaranteed-missing-whisper-model.bin"),
            },
        );
        let mut service = ProviderTranscriberService::new(
            Vec::new(),
            HashMap::new(),
            profiles,
            None,
            None,
            false,
        );
        let error = service
            .prepare(CommandPrepareOptions::Provider(ProviderPrepareOptions {
                provider: ProviderKind::Whisper,
                model_id: "whisper:missing".into(),
                api_key: String::new(),
            }))
            .expect_err("a missing registered model must fail");
        assert_eq!(error.code(), TranscriptionErrorCode::ModelNotFound);
    }

    #[test]
    fn byte_input_still_requires_a_prepared_provider() {
        let error = service(false)
            .transcribe_audio(vec![1, 2, 3], TranscribeOptions::default())
            .expect_err("audio cannot run without a prepared provider");
        assert_eq!(error.code(), TranscriptionErrorCode::ModelNotPrepared);
    }

    #[test]
    fn whisper_server_and_cli_use_the_same_thread_policy_as_electron() {
        let expected = whisper_thread_count().to_string();
        let server = whisper_server_arguments(Path::new("model.bin"), 8080);
        let cli = whisper_cli_arguments(Path::new("model.bin"), Path::new("recording.wav"), "auto");
        let server_threads = server
            .windows(2)
            .find(|pair| pair[0] == "--threads")
            .map(|pair| pair[1].to_string_lossy().into_owned());
        let cli_threads = cli
            .windows(2)
            .find(|pair| pair[0] == "-t")
            .map(|pair| pair[1].to_string_lossy().into_owned());

        assert_eq!(server_threads.as_deref(), Some(expected.as_str()));
        assert_eq!(cli_threads.as_deref(), Some(expected.as_str()));
        assert!((1..=16).contains(&whisper_thread_count()));
    }
}
