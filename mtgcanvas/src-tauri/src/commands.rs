use tauri::command;
use std::fs;
use std::path::PathBuf;
use std::io::Read;

#[command]
pub fn ping() -> &'static str { "pong" }

#[command]
pub fn load_universe() -> Result<String, String> {
	let candidates = [
		PathBuf::from("all.json"),
		PathBuf::from("../all.json"),
		PathBuf::from("../../all.json"),
	];
	for p in candidates.iter() {
		if p.exists() {
			match fs::File::open(p) {
				Ok(mut f) => {
					let mut buf = String::new();
					if let Err(e) = f.read_to_string(&mut buf) { return Err(format!("read error {}: {}", p.display(), e)); }
					// Basic sanity: should start with '[' or '{'
					if !buf.trim_start().is_empty() { return Ok(buf); }
				}
				Err(e) => return Err(format!("open error {}: {}", p.display(), e))
			}
		}
	}
	Err("all.json not found in expected locations".into())
}
