# Security policy

## Reporting a vulnerability

Do not open a public issue for vulnerabilities or exposed credentials. Use
GitHub's private vulnerability reporting for this repository.

Include affected versions, reproduction steps, impact and any suggested
mitigation. We will acknowledge a complete report as soon as practical and
coordinate disclosure after a fix is available.

## Supported versions

The project is pre-stable. Security fixes are applied to the latest alpha
release and `main`.

## Trust model

- Host applications own microphone permission and recording storage.
- Local model files require an authenticated Model Profile.
- Hosted-provider credentials belong to the caller and must not enter
  diagnostics, logs or repository files.
- Tauri capabilities are deny-by-default except for privacy-safe diagnostics.

