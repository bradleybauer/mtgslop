// Desktop (Node/Tauri) only module. Do not import directly in browser code paths.
// Guard dynamic access via repositories.ts.
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

let db: any | null = null;

export function getDb() {
  if (!db) {
    const path = join(process.cwd(), 'mtgcanvas.sqlite');
    db = new Database(path);
    db.pragma('journal_mode = WAL');
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf-8');
    db.exec(schema);
  }
  return db;
}

export interface CardRow {
  id: number; scryfall_id: string; name: string; type_line: string | null; mana_cost: string | null; cmc: number | null; color_identity: string | null; oracle_text: string | null; layout: string | null;
}

export function insertCard(card: any) {
  const db = getDb();
  const stmt = db.prepare(`INSERT OR IGNORE INTO cards (scryfall_id, name, type_line, mana_cost, cmc, color_identity, oracle_text, layout, json_raw)
    VALUES (@scryfall_id, @name, @type_line, @mana_cost, @cmc, @color_identity, @oracle_text, @layout, @json_raw)`);
  stmt.run({
    scryfall_id: card.id,
    name: card.name,
    type_line: card.type_line || null,
    mana_cost: card.mana_cost || null,
    cmc: card.cmc ?? null,
    color_identity: card.color_identity ? card.color_identity.join('') : null,
    oracle_text: card.oracle_text || null,
    layout: card.layout || null,
    json_raw: JSON.stringify(card)
  });
  const idRow = db.prepare('SELECT id FROM cards WHERE scryfall_id=?').get(card.id) as {id:number};
  if (card.card_faces && Array.isArray(card.card_faces)) {
    const faceStmt = db.prepare(`INSERT INTO card_faces (card_id, face_index, name, mana_cost, oracle_text, image_uri) VALUES (?,?,?,?,?,?)`);
    const insertMany = db.transaction((faces:any[]) => {
      faces.forEach((f: any, idx:number) => faceStmt.run(idRow.id, idx, f.name, f.mana_cost || null, f.oracle_text || null, (f.image_uris && f.image_uris.normal) || null));
    });
    insertMany(card.card_faces);
  }
  return idRow.id;
}
