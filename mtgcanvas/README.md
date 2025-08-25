# MTG Canvas

Local desktop app to organize Magic: The Gathering cards on an infinite zoomable canvas.

Stack: Tauri (Rust shell) + TypeScript + Vite + PixiJS + better-sqlite3.

## MVP Features
- Import Scryfall `all.json` (or subset) into SQLite.
- Render pannable/zoomable canvas with PixiJS.
- Place card instances (sprites) with lazy-loaded images.
- Drag single / multi-select cards.
- Create, rename, delete groups (containers); move groups.
- Zoom into (focus) groups; zoom in/out globally.
- Persist layout (positions, grouping) in SQLite with batched updates.

## Development
(Scaffold scripts will be added once dependencies installed.)

## Directory Structure (planned)
```
mtgcanvas/
  src/
    main.ts          # Pixi bootstrap + scene init
    app.ts           # High-level App orchestrator
    data/
      db.ts          # SQLite connection (better-sqlite3)
      schema.sql     # Schema definition
      importer.ts    # Scryfall JSON importer (streamed)
      repositories.ts
    scene/
      CardSprite.ts
      GroupContainer.ts
      SpatialIndex.ts
      InteractionManager.ts
      Selection.ts
    state/
      commandStack.ts
      selectionStore.ts
    images/
      imageCache.ts
  src-tauri/
    src/
      main.rs        # Tauri entry, commands (fetch image path, etc.)
      commands.rs
    Cargo.toml
  package.json
  vite.config.ts
  tsconfig.json
```

## Next Steps
1. Install dependencies & scaffold Tauri + Vite.
2. Implement schema & importer.
3. Minimal scene with mock cards.
4. Drag, pan, zoom, persist positions.

---
Work in progress.
