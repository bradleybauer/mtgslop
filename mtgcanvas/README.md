# MTG Canvas

Web app to organize Magic: The Gathering cards on an infinite zoomable canvas.

Stack: TypeScript + Vite + PixiJS.

## MVP Features
- Import Scryfall `legal.json` (preferred smaller subset) or `all.json` into SQLite.
- Render pannable/zoomable canvas with PixiJS.
- Place card instances (sprites) with lazy-loaded images.
- Drag single / multi-select cards.
- Create, rename, delete groups (containers); move groups.
- Zoom into (focus) groups; zoom in/out globally.
- Persist layout (positions, grouping) in SQLite with batched updates.

## Development
(Scaffold scripts will be added once dependencies installed.)

## Directory Structure (current)
```
mtgcanvas/
  src/
    main.ts          # Pixi bootstrap + scene init
    app.ts           # High-level App orchestrator
    data/
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
  package.json
  vite.config.ts
  tsconfig.json
```

## Next Steps
1. Install dependencies (npm ci) and run the dev server (npm run dev).
2. Place `legal.json` (or `all.json`) in `mtgcanvas/public/` or `notes/` directory. The app prefers `legal.json` if both exist.
3. Drag, pan, zoom, and persist positions in LocalStorage; imported cards are stored in IndexedDB.

---
Work in progress.
