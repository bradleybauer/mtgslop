-- Core tables
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  scryfall_id TEXT UNIQUE,
  name TEXT,
  type_line TEXT,
  mana_cost TEXT,
  cmc REAL,
  color_identity TEXT,
  oracle_text TEXT,
  layout TEXT,
  json_raw BLOB
);

CREATE TABLE IF NOT EXISTS card_faces (
  id INTEGER PRIMARY KEY,
  card_id INTEGER,
  face_index INTEGER,
  name TEXT,
  mana_cost TEXT,
  oracle_text TEXT,
  image_uri TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id)
);

CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER,
  name TEXT,
  collapsed INTEGER DEFAULT 0,
  transform_json TEXT,
  FOREIGN KEY(parent_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS card_instances (
  id INTEGER PRIMARY KEY,
  card_id INTEGER,
  group_id INTEGER,
  x REAL,
  y REAL,
  z INTEGER,
  rotation REAL,
  scale REAL,
  tags TEXT,
  FOREIGN KEY(card_id) REFERENCES cards(id),
  FOREIGN KEY(group_id) REFERENCES groups(id)
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_card_name ON cards(name);
CREATE INDEX IF NOT EXISTS idx_instance_group ON card_instances(group_id);
CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_id);
