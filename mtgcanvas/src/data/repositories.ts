// Browser-safe repositories: lazily attempt to load real DB (better-sqlite3) only in desktop/Tauri.
// Falls back to in-memory stores when unavailable so UI can function for perf / UX work.
// NOTE: Persistence is intentionally skipped in fallback mode.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;

let _getDb: (()=>any) | null = null;
let _attempted = false;
function getDbSafe() {
  if (!_attempted) {
    _attempted = true;
    if (typeof window === 'undefined' || (window as any).__TAURI__) {
      try {
        // Dynamic require to avoid bundler static inclusion
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require('./db');
        if (mod && mod.getDb) _getDb = mod.getDb;
      } catch (e) {
        console.warn('[repositories] DB module not available, using in-memory fallback');
      }
    }
  }
  return _getDb ? _getDb() : null;
}

export function hasRealDb(){ return !!_getDb; }

export interface CardInstance { id: number; card_id: number; group_id: number | null; x:number; y:number; z:number; rotation:number; scale:number; tags:string|null; }

export interface GroupRow { id:number; parent_id:number|null; name:string|null; collapsed:number; transform_json:string|null; }

// In-memory fallback stores
const mem = { instances: [] as CardInstance[], groups: [] as GroupRow[] };
let memInstanceId = 1; let memGroupId = 1;
let warnedFallback = false;
function warnOnce(msg:string){ if (!warnedFallback){ console.warn(msg); warnedFallback=true; } }

export const InstancesRepo = {
  create(card_id:number, x:number, y:number) {
    const db = getDbSafe();
    if (db) {
      const stmt = db.prepare(`INSERT INTO card_instances (card_id, group_id, x, y, z, rotation, scale, tags) VALUES (?,?,?,?,?,?,?,?)`);
      const info = stmt.run(card_id, null, x, y, 0, 0, 1, null);
      return info.lastInsertRowid as number;
    }
    warnOnce('[InstancesRepo] Using in-memory create');
    const inst: CardInstance = { id: memInstanceId++, card_id, group_id: null, x, y, z:0, rotation:0, scale:1, tags:null };
    mem.instances.push(inst);
    return inst.id;
  },
  list() {
    const db = getDbSafe();
  if (db) return db.prepare('SELECT id, card_id, group_id, x, y, z, rotation, scale, tags FROM card_instances').all() as CardInstance[];
    warnOnce('[InstancesRepo] Using in-memory list');
    return mem.instances;
  },
  deleteMany(ids:number[]) {
    if (!ids.length) return; const db = getDbSafe();
    if (db) {
      const stmt = db.prepare(`DELETE FROM card_instances WHERE id IN (${ids.map(()=>'?').join(',')})`);
      stmt.run(...ids); return;
    }
    mem.instances = mem.instances.filter(i=> !ids.includes(i.id));
  },
  updatePositions(batch: {id:number,x:number,y:number}[]) {
    if (!batch.length) return; const db = getDbSafe();
    if (db) {
      const stmt = db.prepare('UPDATE card_instances SET x=?, y=? WHERE id=?');
      const tx = db.transaction((rows: typeof batch)=>{ rows.forEach(r=> stmt.run(r.x, r.y, r.id)); }); tx(batch); return;
    }
    batch.forEach(r=> { const inst = mem.instances.find(i=> i.id===r.id); if (inst){ inst.x=r.x; inst.y=r.y; } });
  },
  updateMany(batch: {id:number,x?:number,y?:number,z?:number,group_id?:number|null}[]) {
    if (!batch.length) return; const db = getDbSafe();
    if (db) {
      const stmt = db.prepare('UPDATE card_instances SET x=COALESCE(?,x), y=COALESCE(?,y), z=COALESCE(?,z), group_id=COALESCE(?,group_id) WHERE id=?');
      const tx = db.transaction((rows: typeof batch)=>{ rows.forEach(r=> stmt.run(r.x ?? null, r.y ?? null, r.z ?? null, r.group_id === undefined ? null : r.group_id, r.id)); }); tx(batch); return;
    }
    batch.forEach(r=> { const inst = mem.instances.find(i=> i.id===r.id); if (inst){ if (r.x!==undefined) inst.x=r.x; if (r.y!==undefined) inst.y=r.y; if (r.z!==undefined) inst.z=r.z; if (r.group_id!==undefined) inst.group_id=r.group_id ?? null; } });
  }
};

export const GroupsRepo = {
  create(name:string|null, parent_id:number|null, x:number, y:number, w:number=300, h:number=300) {
    const db = getDbSafe();
    if (db) {
      const stmt = db.prepare('INSERT INTO groups (parent_id, name, collapsed, transform_json) VALUES (?,?,0,?)');
      const info = stmt.run(parent_id, name, JSON.stringify({x,y,w,h}));
      return info.lastInsertRowid as number;
    }
    const row: GroupRow = { id: memGroupId++, parent_id, name, collapsed:0, transform_json: JSON.stringify({x,y,w,h}) };
    mem.groups.push(row); return row.id;
  },
  list() {
    const db = getDbSafe(); if (db) return db.prepare('SELECT id,parent_id,name,collapsed,transform_json FROM groups').all() as GroupRow[];
    return mem.groups as any;
  },
  deleteMany(ids:number[]) {
    if (!ids.length) return; const db = getDbSafe();
    if (db) { const stmt = db.prepare(`DELETE FROM groups WHERE id IN (${ids.map(()=>'?').join(',')})`); stmt.run(...ids); return; }
    mem.groups = mem.groups.filter(g=> !ids.includes(g.id));
  },
  updateTransform(id:number, t:{x:number,y:number,w:number,h:number}) {
    const db = getDbSafe();
    const json = JSON.stringify(t);
    if (db) { db.prepare('UPDATE groups SET transform_json=? WHERE id=?').run(json, id); return; }
    const g = mem.groups.find(g=> g.id===id); if (g) (g as any).transform_json = json;
  },
  setCollapsed(id:number, collapsed:boolean) {
    const db = getDbSafe();
    if (db) { db.prepare('UPDATE groups SET collapsed=? WHERE id=?').run(collapsed?1:0, id); return; }
    const g = mem.groups.find(g=> g.id===id); if (g) g.collapsed = collapsed?1:0;
  },
  rename(id:number, name:string) {
    const db = getDbSafe();
    if (db) { db.prepare('UPDATE groups SET name=? WHERE id=?').run(name, id); return; }
    const g = mem.groups.find(g=> g.id===id); if (g) g.name = name;
  }
  ,
  /**
   * Memory-only: ensure the next generated group id is at least `min`.
   * No-op when a real DB is present.
   */
  ensureNextId(min:number){
    const db = getDbSafe(); if (db) return;
    if (typeof min === 'number' && isFinite(min)) {
      // Bump the counter to avoid collisions with externally restored ids
      if (min > memGroupId) memGroupId = min;
    }
  }
};
