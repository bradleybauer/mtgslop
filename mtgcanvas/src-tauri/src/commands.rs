use tauri::command;
use std::fs;
use std::path::PathBuf;
use std::io::Read;

#[command]
pub fn ping() -> &'static str { "pong" }

#[command]
pub fn load_universe() -> Result<String, String> {
	// Keep these in sync with TypeScript config/dataset.ts
	const PREFERRED: &str = "legal.json";
	const FALLBACK: &str = "all.json";
	let candidates = [
		PathBuf::from(PREFERRED),
		PathBuf::from(format!("../{}", PREFERRED)),
		PathBuf::from(format!("../../{}", PREFERRED)),
		PathBuf::from(format!("../notes/{}", PREFERRED)),
		PathBuf::from(format!("../../notes/{}", PREFERRED)),
		PathBuf::from(FALLBACK),
		PathBuf::from(format!("../{}", FALLBACK)),
		PathBuf::from(format!("../../{}", FALLBACK)),
		PathBuf::from(format!("../notes/{}", FALLBACK)),
		PathBuf::from(format!("../../notes/{}", FALLBACK)),
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
	Err(format!("{} or {} not found in expected locations", PREFERRED, FALLBACK))
}
