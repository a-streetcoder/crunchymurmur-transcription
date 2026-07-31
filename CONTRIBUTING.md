# Contributing

Thank you for improving CrunchyMurmur Transcription.

## Development

Requirements:

- Node.js 22.12 or later
- Rust 1.88 or later
- Platform build tools required by Tauri and ONNX Runtime

Run the checks before opening a pull request:

```bash
npm ci
npm run check
cargo test --locked --manifest-path native/transcriber/Cargo.toml
cargo test --locked --manifest-path packages/transcribe-tauri/Cargo.toml
```

Changes to an adapter must preserve the shared `prepare`, `transcribe`,
`diagnostics`, and `dispose` lifecycle and add conformance coverage. New hosted
providers must keep credentials out of logs and diagnostics, map errors to
stable codes, and remain optional for local-only consumers.

Use a focused branch, include tests and documentation, and explain observable
interface or performance changes in the pull request.

