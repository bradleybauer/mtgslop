declare module "better-sqlite3";
declare module "@tauri-apps/api/fs" {
  export function readTextFile(path: string): Promise<string>;
}
// Global __TAURI__ minimal typing
interface __TauriGlobal {
  invoke<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  fs?: { readTextFile(path: string): Promise<string> };
}
interface Window {
  __TAURI__?: __TauriGlobal;
}
declare module "stream-json";
declare module "stream-json/streamers/StreamArray";
declare module "stream-chain";
