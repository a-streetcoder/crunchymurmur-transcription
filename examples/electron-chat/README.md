# SDK chat demo

This Electron application demonstrates the public
`@crunchymurmur/transcribe-node` and optional
`@crunchymurmur/transcribe-groq` interfaces in a complete chat composer. Its Host
Recorder supports microphone selection and a configurable global recording
shortcut, captures microphone PCM, writes a short-lived WAV through the
isolated main process, and passes only that local path to the On-device Engine.
The temporary file is removed after every successful or failed transcription.

The demo does not call a chat provider. Sending a message adds a local example
reply. Parakeet and Whisper transcription remain fully local; the optional Groq
choice sends the recorded clip to the user's Groq account.

## Run from this repository

Requirements:

- Node.js 22.12 or newer;
- Rust 1.88 or newer and the native build tools for your platform;
- a downloaded CrunchyMurmur Parakeet Model Profile or Whisper GGML model;
- microphone permission.

Build the local runtime once:

```powershell
npm run prepare:transcriber:win
```

On macOS or Linux, use `prepare:transcriber:mac` or
`prepare:transcriber:linux`. Then install and start the independent example:

```powershell
npm run demo:chat:install
npm run demo:chat
```

The demo resolves the runtime from `CRUNCHYMURMUR_TRANSCRIBER_PATH`, this
repository's `build/transcriber-runtime` directory, `PATH`, or Cargo's binary
directory, in that order.

## Run from an SDK GitHub release

Download `crunchymurmur-sdk-chat-demo.zip` from the matching SDK GitHub
prerelease. The archive contains `examples/electron-chat` and its exact local
adapter dependencies at `packages/transcribe-node` and
`packages/transcribe-groq`. After extracting the
archive without changing that directory structure, install the native runtime
and start the example:

```sh
cargo install crunchymurmur-transcriber --version 0.1.0-alpha.1 --locked
cd examples/electron-chat
npm ci
npm start
```

Open **Transcription settings** and choose:

1. an installed on-device model;
2. the microphone used for voice messages;
3. the spoken language, or **Automatic**;
4. the global recording shortcut.

Choose **Groq (cloud)** to use a Groq API key for the current process only. The
demo never writes that key to renderer storage or disk. The key and recorded
audio are sent only to Groq when this engine is selected.

The demo discovers the verified Parakeet model installed by CrunchyMurmur. If
the desktop app installed that model before Model Profiles were introduced, the
demo upgrades it using the release metadata embedded in the signed host. When
no model is present, **Download model** installs and verifies the recommended
profile. Model directories and manifest digests never cross into the renderer.

On Windows, the default shortcut is **Ctrl + Win**: hold it while speaking and
release either key to transcribe. The macOS default is **Command + Shift +
Space** and the Linux default is **Ctrl + Shift + Space**; those shortcuts
toggle recording.

## Security shape

- `contextIsolation`, renderer sandboxing, and a narrow preload interface are
  enabled.
- Only a model ID crosses from the renderer; the main process resolves it to a
  host-authenticated Model Profile.
- Groq credentials remain in the privileged main process and are cleared when
  the process exits.
- Model downloads are HTTPS-only and every file is checked against the
  host-pinned size and SHA-256 before installation.
- The renderer cannot access Node.js, the native process, or arbitrary files.
- Recorded WAV input is limited to 25 MB and stored with a unique name.
- Temporary audio is deleted in a `finally` block.
- Local engines perform no network requests or telemetry.
