# Building from source

## Requirements

- Node.js 22.12 or later
- Rust 1.88 or later
- Git
- Platform C/C++ build tools
- Tauri 2 operating-system dependencies when building the Tauri example

## Validate

```bash
npm ci
npm run check
cargo test --locked --manifest-path native/transcriber/Cargo.toml
cargo test --locked --manifest-path packages/transcribe-tauri/Cargo.toml
```

## Native runtimes

Prepare the release-built Parakeet sidecar and whisper.cpp tools for the current
platform:

```bash
npm run prepare:transcriber:win
npm run prepare:whisper:win
```

Use the corresponding `mac` or `linux` commands elsewhere. Generated runtimes
are kept under `build/` and are intentionally not committed.

## Examples

```bash
npm run demo:electron:install
npm run demo:electron
```

```bash
npm run demo:tauri:install
npm run demo:tauri
```

The normal Tauri demo uses release optimisation for representative inference
performance. Use `npm run demo:tauri:debug` for faster Rust rebuilds.

