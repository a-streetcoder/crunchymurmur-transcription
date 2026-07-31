# CrunchyMurmur Tauri transcription adapter

This alpha Tauri 2 desktop plugin provides Parakeet, local Whisper and optional
BYO-key Groq transcription on Windows, macOS and Linux. Parakeet links the
CrunchyMurmur Rust engine directly. Whisper keeps a host-verified
`whisper-server` warm with a `whisper-cli` fallback. Groq is disabled unless the
host explicitly enables it.

The crate and JavaScript guest package are published together from an immutable
`v<version>` tag after their shared release checks pass.

The current native engine dependency requires Rust 1.88 or newer.

## Host setup

Add the Rust crate to the Tauri application's `src-tauri/Cargo.toml` and
register it with one or more existing, host-owned recording directories:

```rust
let transcription = tauri_plugin_crunchymurmur_transcribe::PluginConfig::new()
    .allow_audio_root(recordings_directory)
    .register_parakeet_model(
        "parakeet-v3",
        parakeet_model_directory,
        trusted_manifest_sha256,
    )
    .register_whisper_model("whisper:turbo", whisper_model_path)
    .whisper_runtime(Some(whisper_cli), Some(whisper_server))
    .enable_groq();

tauri::Builder::default()
    .plugin(tauri_plugin_crunchymurmur_transcribe::init(transcription))
    .run(tauri::generate_context!())
    .expect("failed to run Tauri application");
```

The configuration is deny-by-default: with no allowed audio roots, filesystem
transcription is unavailable. Canonical path checks prevent webview code from
reading files outside the configured directories.

The default permission set exposes privacy-safe diagnostics only. Grant the
commands needed by a trusted window in its Tauri capability:

```json
{
  "permissions": [
    "crunchymurmur-transcribe:allow-prepare",
    "crunchymurmur-transcribe:allow-transcribe",
    "crunchymurmur-transcribe:allow-transcribe-audio",
    "crunchymurmur-transcribe:allow-dispose",
    "crunchymurmur-transcribe:allow-diagnostics"
  ]
}
```

Raw `Uint8Array` transcription uses Tauri's internal custom-protocol transport.
If the host sets a Content Security Policy, its `connect-src` must allow
`ipc:` and `http://ipc.localhost`. Without those entries, Tauri falls back to
JSON IPC and the plugin rejects the recording as `AUDIO_INVALID`.

Then call the guest API:

```js
import { createTranscriber } from '@crunchymurmur/transcribe-tauri';

const transcriber = createTranscriber({
  provider: 'parakeet',
  modelId: 'parakeet-v3',
});
await transcriber.prepare();

const result = await transcriber.transcribe(
  { path: recordedWavPath },
  { language: 'auto' },
);
```

The same interface selects local Whisper:

```js
const whisper = createTranscriber({
  provider: 'whisper',
  modelId: 'whisper:turbo',
});
await whisper.prepare();
const result = await whisper.transcribe({ bytes: recordedWavBytes });
```

Groq credentials are passed once at preparation and retained only in native
session memory:

```js
const groq = createTranscriber({
  provider: 'groq',
  modelId: 'whisper-large-v3-turbo',
  apiKey: sessionGroqKey,
});
await groq.prepare();
```

The host owns microphone permission, device selection, WAV creation, retention,
the allowed recording roots, registered local models, verified runtime paths
and authenticated Model Profile digests. Raw byte transcription avoids granting
the webview a recording directory. Expose provider commands only to trusted
windows.

## Current preview boundary

- One provider/model is kept warm and one inference runs at a time.
- Input is a local WAV-compatible audio path or raw WAV bytes.
- PCM WAV input is downmixed and resampled from common native microphone rates
  to the engine's 16 kHz rate.
- Persistent `whisper-server` and CLI fallback use the same capped 16-thread
  policy as the Electron adapter.
- Results are final `speech` or `no-speech` outcomes.
- Model manifests and every declared model file are verified before loading.
- Diagnostics read a lightweight snapshot without waiting for inference.
- Disposal waits for active inference before releasing the model.
- Cancellation, streaming PCM sessions, and packaged model delivery remain
  follow-up work.
