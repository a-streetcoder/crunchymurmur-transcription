# Tauri SDK chat demo

This standalone Tauri 2 application runs the same localised chat interface as
the Electron demo while exercising the Rust Tauri plugin directly.

It demonstrates:

- Parakeet with authenticated Model Profiles and native audio normalisation;
- persistent local Whisper with a host-registered GGML model and CLI fallback;
- optional Groq transcription with a session-only BYO API key;
- raw binary recording handoff without exposing a recording directory;
- microphone, spoken-language, model and global-shortcut selection.

## Run

From the repository root:

```powershell
npm run prepare:whisper:win
npm run demo:tauri:install
npm run demo:tauri
```

Use `prepare:whisper:mac` or `prepare:whisper:linux` on those platforms. The
demo discovers the models installed by CrunchyMurmur. If Parakeet is missing,
the in-demo download verifies every file against the host-pinned release
metadata before installing it.

The normal demo command uses Tauri's release profile so On-device Engine
performance matches the optimised native runtime used by the Electron demo.
Use `npm run demo:tauri:debug` only when Rust debugging and faster rebuilds are
more important than representative inference timings.

The demo frontend is shared with `examples/electron-chat`; `host-adapter.js`
selects the appropriate privileged host interface at runtime. This keeps the
visible behaviour aligned while Electron and Tauri retain their native process
and permission models.

The preparation step preserves Electron's `connect-src 'none'` policy in the
source page while allowing only Tauri's internal `ipc:` and
`http://ipc.localhost` transports in the generated demo. Raw recording bytes
cannot cross Tauri IPC if those internal transports are blocked.

The demo uses a modifier-plus-key global shortcut because Tauri's portable
global-shortcut implementation does not register modifier-only chords. The
default is **Ctrl + Shift + D** on Windows and Linux and **Command + Shift +
D** on macOS.
