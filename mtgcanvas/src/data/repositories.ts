import { getDb } from './db';

export interface CardInstance {
  id: number; card_id: number; group_id: number | null; x:number; y:number; z:number; rotation:number; scale:number; tags:string|null;
}

export interface GroupRow { id:number; parent_id:number|null; name:string|null; collapsed:number; }

export const InstancesRepo = {
  create(card_id:number, x:number, y:number) {
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO card_instances (card_id, group_id, x, y, z, rotation, scale, tags) VALUES (?,?,?,?,?,?,?,?)`);
    const info = stmt.run(card_id, null, x, y, 0, 0, 1, null);
    return info.lastInsertRowid as number;
  },
  list() {
    return getDb().prepare('SELECT * FROM card_instances').all() as CardInstance[];
  },
  deleteMany(ids:number[]) {
    if (!ids.length) return; const db = getDb();
    const stmt = db.prepare(`DELETE FROM card_instances WHERE id IN (${ids.map(()=>'?').join(',')})`);
    stmt.run(...ids);
  },
  updatePositions(batch: {id:number,x:number,y:number}[]) {
    if (!batch.length) return;
    const db = getDb();
    const stmt = db.prepare('UPDATE card_instances SET x=?, y=? WHERE id=?');
    const tx = db.transaction((rows: typeof batch)=>{ rows.forEach(r=> stmt.run(r.x, r.y, r.id)); });
    tx(batch);
  },
  updateMany(batch: {id:number,x?:number,y?:number,z?:number,group_id?:number|null}[]) {
    if (!batch.length) return;
    const db = getDb();
    const stmt = db.prepare('UPDATE card_instances SET x=COALESCE(?,x), y=COALESCE(?,y), z=COALESCE(?,z), group_id=COALESCE(?,group_id) WHERE id=?');
    const tx = db.transaction((rows: typeof batch)=>{ rows.forEach(r=> stmt.run(r.x ?? null, r.y ?? null, r.z ?? null, r.group_id === undefined ? null : r.group_id, r.id)); });
    tx(batch);
  }
};

export const GroupsRepo = {
  create(name:string|null, parent_id:number|null, x:number, y:number) {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO groups (parent_id, name, collapsed, transform_json) VALUES (?,?,0,?)');
    const info = stmt.run(parent_id, name, JSON.stringify({x,y}));
    return info.lastInsertRowid as number;
  },
  list() {
    return getDb().prepare('SELECT * FROM groups').all() as GroupRow[];
  },
  deleteMany(ids:number[]) {
    if (!ids.length) return; const db = getDb();
    const stmt = db.prepare(`DELETE FROM groups WHERE id IN (${ids.map(()=>'?').join(',')})`);
    stmt.run(...ids);
  }
};
