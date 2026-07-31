const COMMANDS: &[&str] = &[
    "prepare",
    "transcribe",
    "transcribe_audio",
    "diagnostics",
    "dispose",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
