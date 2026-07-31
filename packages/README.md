# On-device transcription packages

This directory contains the reusable host adapters built on CrunchyMurmur's
native Rust transcription engine.

| Package | Status | Purpose |
|---|---|---|
| [`@crunchymurmur/transcribe-node`](transcribe-node/) | `0.1.0-alpha.1` release candidate | Node.js and Electron main-process adapter |
| [`@crunchymurmur/transcribe-groq`](transcribe-groq/) | `0.1.0-alpha.1` release candidate | Optional BYO-key Groq adapter for Node.js and Electron |
| [`@crunchymurmur/transcribe-tauri`](transcribe-tauri/) | `0.1.0-alpha.1` release candidate | Tauri 2 adapter for Parakeet, local Whisper and opt-in Groq |

The Rust library lives in [`native/transcriber`](../native/transcriber/). The
same crate builds both the reusable engine and CrunchyMurmur's isolated sidecar.
Keeping the desktop app on this shared implementation prevents the SDK and the
product from drifting.

Tags in the form `v<version>` validate and publish all npm adapters, the
Rust engine crate, and the Tauri plugin, then create a prerelease with package
archives, checksums, provenance attestations, and the
[`electron-chat`](../examples/electron-chat/) integration example. Registry
credentials are required for the bootstrap tag. Once the packages exist, their
registry settings can trust the workflow and later releases can migrate from
bootstrap tokens to short-lived OIDC credentials. Cross-platform runtime
archives and published benchmarks remain follow-up work; see the
[SDK guide](../docs/on-device-sdk.md) for the delivery sequence.
