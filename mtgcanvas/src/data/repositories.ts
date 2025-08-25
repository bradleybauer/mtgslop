import { getDb } from './db';

export interface CardInstance {
  id: number; card_id: number; group_id: number | null; x:number; y:number; z:number; rotation:number; scale:number; tags:string|null;
}

export const InstancesRepo = {
  create(card_id:number, x:number, y:number) {
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO card_instances (card_id, group_id, x, y, z, rotation, scale, tags) VALUES (?,?,?,?,?,?,?,?)`);
    const info = stmt.run(card_id, null, x, y, 0, 0, 1, null);
    return info.lastInsertRowid as number;
  },
  updatePositions(batch: {id:number,x:number,y:number}[]) {
    if (!batch.length) return;
    const db = getDb();
    const stmt = db.prepare('UPDATE card_instances SET x=?, y=? WHERE id=?');
    const tx = db.transaction((rows: typeof batch)=>{ rows.forEach(r=> stmt.run(r.x, r.y, r.id)); });
    tx(batch);
  }
};
