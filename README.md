# CrunchyMurmur Transcription

[![CI](https://github.com/a-streetcoder/crunchymurmur-transcription/actions/workflows/ci.yml/badge.svg)](https://github.com/a-streetcoder/crunchymurmur-transcription/actions/workflows/ci.yml)
[![CodeQL](https://github.com/a-streetcoder/crunchymurmur-transcription/actions/workflows/codeql.yml/badge.svg)](https://github.com/a-streetcoder/crunchymurmur-transcription/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-256351.svg)](LICENSE)
[![Alpha](https://img.shields.io/badge/status-alpha-f79164.svg)](CHANGELOG.md)

Local-first speech-to-text primitives for desktop applications. One small
transcriber interface supports Parakeet, whisper.cpp and optional hosted
providers without making the engine own microphone permissions, application UI
or user data.

The project was extracted from
[CrunchyMurmur](https://github.com/a-streetcoder/CrunchyMurmur) so other
Electron, Node.js and Tauri applications can use the same tested engine.

## Packages

| Package | Host | Engines |
|---|---|---|
| [`@crunchymurmur/transcribe-node`](packages/transcribe-node/) | Node.js and Electron main process | Parakeet, whisper.cpp |
| [`@crunchymurmur/transcribe-tauri`](packages/transcribe-tauri/) | Tauri 2 desktop | Parakeet, whisper.cpp, opt-in Groq |
| [`@crunchymurmur/transcribe-groq`](packages/transcribe-groq/) | Node.js and Electron main process | Groq Whisper |
| [`crunchymurmur-transcriber`](native/transcriber/) | Rust library or isolated sidecar | Parakeet |

All packages are currently `0.1.0-alpha.1`. Interfaces may change before the
first stable release.

## Interface

Every adapter exposes the same lifecycle:

```js
const transcriber = createTranscriber(configuration);

await transcriber.prepare();
const transcript = await transcriber.transcribe(
  { path: recordedWavPath },
  { language: 'auto' },
);
const diagnostics = await transcriber.diagnostics();
await transcriber.dispose();
```

The host application owns microphone permission, input-device selection,
recording, model acquisition and retention. The transcriber receives local
audio and returns a final `speech` or `no-speech` outcome.

## Quick start

Until the first registry release, clone the repository and run the complete
validation suite:

```bash
git clone https://github.com/a-streetcoder/crunchymurmur-transcription.git
cd crunchymurmur-transcription
npm ci
npm run check
cargo test --locked --manifest-path native/transcriber/Cargo.toml
cargo test --locked --manifest-path packages/transcribe-tauri/Cargo.toml
```

Run the Electron example:

```bash
npm run prepare:transcriber:win
npm run prepare:whisper:win
npm run demo:electron:install
npm run demo:electron
```

Use the `mac` or `linux` runtime commands on those platforms. The
[Tauri example](examples/tauri-chat/) uses the same interface and localised UI:

```bash
npm run demo:tauri:install
npm run demo:tauri
```

## Design guarantees

- Audio stays on-device for Parakeet and whisper.cpp.
- Hosted providers require explicit host opt-in and caller-owned credentials.
- Model paths and credentials never appear in public diagnostics.
- Model Profiles authenticate local model files before loading.
- One prepared model is reused across Voice Sessions.
- Stable error codes are shared across adapters.
- Raw Tauri audio is bounded and crosses native binary IPC.

See the [SDK guide](docs/on-device-sdk.md), [security policy](SECURITY.md), and
[contribution guide](CONTRIBUTING.md).

## Platform status

| Host | Windows | macOS | Linux |
|---|---:|---:|---:|
| Node.js / Electron | Supported | Supported | Supported |
| Tauri 2 desktop | Supported | Supported | Supported |
| Swift, Kotlin, React Native | Planned | Planned | Planned |

## Licence

MIT. See [LICENSE](LICENSE).
