# Release process

All public packages use one semantic version during the alpha.

1. Update every npm and Cargo manifest.
2. Update `CHANGELOG.md`.
3. Run:

   ```bash
   npm run release:check -- v0.1.0-alpha.1
   npm run check
   cargo test --locked --manifest-path native/transcriber/Cargo.toml
   cargo test --locked --manifest-path packages/transcribe-tauri/Cargo.toml
   ```

4. Create and push the immutable `v<version>` tag.

The release workflow publishes the Rust engine before the dependent Tauri
plugin, publishes npm packages with provenance, and creates a GitHub prerelease
containing package archives, examples and checksums.

The bootstrap release requires `CARGO_REGISTRY_TOKEN` and `NPM_TOKEN`
repository secrets. Migrate to registry trusted publishing after package
ownership has been established.

