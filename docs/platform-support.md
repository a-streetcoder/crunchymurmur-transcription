# Platform support

| Adapter | Windows x64 | Windows ARM64 | macOS universal | Linux x64 | Linux ARM64 |
|---|---:|---:|---:|---:|---:|
| Node.js / Electron | Supported | Supported through x64 runtime emulation | Supported | Supported | Supported |
| Tauri 2 desktop | Supported | Supported | Supported | Supported | Supported |
| Rust engine | Supported | Supported | Supported | Supported | Supported |

Parakeet acceleration depends on the ONNX Runtime execution providers available
to the host build. whisper.cpp performance depends on model size, CPU features
and optional platform acceleration.

Swift, Kotlin, React Native, iOS and Android adapters are planned but are not
part of the current alpha.

