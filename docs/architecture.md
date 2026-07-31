# Architecture

The repository is organised around one deep On-device Engine module and a
small transcriber interface.

```text
Host application
  └─ Host Recorder
       └─ Host Adapter
            ├─ Node/Electron adapter
            ├─ Tauri plugin
            └─ Hosted-provider adapter
                 └─ On-device Engine or explicit remote provider
```

The external seam has four operations:

- `prepare`
- `transcribe`
- `diagnostics`
- `dispose`

The host owns microphone permissions, recording and model acquisition. Local
engines never make network requests. Hosted providers are optional adapters
that require caller-owned credentials.

See [on-device-sdk.md](on-device-sdk.md) for lifecycle, errors, audio formats,
Model Profiles and future native adapters.

