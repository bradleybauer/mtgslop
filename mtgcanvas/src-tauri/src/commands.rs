use tauri::command;

#[command]
pub fn ping() -> &'static str { "pong" }
