# MTG Slop

MTG Slop is a fast, local-first web app to organize Magic: The Gathering cards on an infinite, zoomable canvas. Drag cards around, group them, search, and import/export decklists — all rendered with buttery-smooth WebGL via PixiJS.

Tech: TypeScript + Vite + PixiJS. Runs entirely in your browser; no server required.

## Features

- Infinite canvas with smooth pan, zoom, and inertial camera movement
- Drag to move single or multi-selected cards; marquee selection
- Create, rename, and delete groups; auto-pack cards in a group
- Zoom-to-fit all content or selection; focus/animate to content
- Import decklists from text (counts supported: "4 Lightning Bolt")
- Import from Scryfall search, creating a group with results
- Search palette (Ctrl+F or "/") with Scryfall-like query syntax
- Theme-aware UI with a lightweight help overlay and FAB controls
- Local-first persistence: positions/groups in LocalStorage; imported cards in IndexedDB
- Smart image and GPU budgeting: adaptive hi-res textures, decode queue, and cache

## Quick start

1) Install dependencies and start the dev server.

```
npm ci
npm run dev
```

2) Open the app (Vite will print a local URL). You’ll see a splash while the canvas initializes.

3) Press Ctrl+I to open Import/Export. Paste a decklist or run a Scryfall query to add cards.

## Usage basics

- Pan: hold Space and drag, or Right Mouse Drag
- Zoom: Mouse Wheel at cursor, Ctrl + (+/-), or Reset with Ctrl+0
- Select: Click; Shift+Click to toggle; Drag empty space for marquee (Shift = additive)
- Group: Press G to create a group around selection (or make an empty group at center)
- Delete: Delete key (cards or groups)
- Find/search: Ctrl+F or "/" opens the Search Palette
- Fit view: F (all), Shift+F or Z (selection)

These are also listed in the in-app Help (hover the "?" button in the top-right).

### Keyboard shortcuts

- Navigation: Pan (Space+Drag / RMB), Zoom (Wheel), Zoom In/Out (Ctrl + +/-), Fit All (F), Fit Selection (Shift+F or Z), Reset Zoom (Ctrl+0)
- Selection: Single (Click), Add/Toggle (Shift+Click), Marquee (Drag; Shift additive), Select All / Clear (Ctrl+A / Esc), Delete (Delete)
- Groups: Create (G), Delete (Delete)
- Search: Open (Ctrl+F or "/")
- Import/Export: Ctrl+I

## Import and Export

Open Import/Export with Ctrl+I.

- Text import: paste a list like:
  - `4 Lightning Bolt`\n`2 Counterspell`\n`Island x8`
  - Counts are recognized (xN or leading integers). Unknown names are reported.
- Groups import: paste a simple format using headings and bullet lines; groups are created with cards placed inside.
- Export: choose “All” or “Selection” to copy or download a decklist (optionally grouped).
- Scryfall search import: enter a Scryfall-style query (e.g., `o:infect t:creature cmc<=3`). Results import into a new group named after your query.

Notes:
- Scryfall imports are paged with progress and limited by a safety cap and device budget.
- Imported Scryfall cards are stored in IndexedDB so they persist across reloads.

## Search Palette

Press Ctrl+F or "/" to open. Type Scryfall-like queries; Enter will create a group with the matches.

- Filter buttons: All, Ungrouped, Grouped
- Navigate matches with the ◀ ▶ buttons or Alt+Left/Alt+Right
- Query syntax highlights:
  - Free text matches name and oracle. Quote phrases: "draw a card"
  - Fields: `o:` (oracle), `t:` (type), `name:`/`n:`, `r:` (rarity), `e:` (set), `c:`/`ci:` (colors/identity), `mv:` (mana value), `pow:`/`tou:`/`loy:`
  - Colors: `c=uw`, `c>=ug`, `c<=wub`, `color=rg`
  - Comparisons: `mv>=3`, `pow>tou`, prices like `usd>1`
  - Flags: `is:dfc`, `is:modal`, `has:watermark`

## Data & persistence

All data is local to your browser:

- Card positions and group transforms: LocalStorage key `mtgcanvas_positions_v1` and `mtgcanvas_groups_v1`
- Imported Scryfall cards: IndexedDB database `mtgCanvas`, object store `imported_cards` (keyed by Scryfall id)

If you need to reset, you can clear these via your browser’s devtools or use the Clear option when available in the Import/Export panel.

## Performance and limits

- Rendering: PixiJS on WebGL; an adaptive texture budget is auto-detected per device and can be overridden via `localStorage.setItem("gpuBudgetMB", "2048")`.
- Image pipeline: background decode queue, hi/med texture quality tapering by distance, and GPU texture eviction when over budget.
- Spatial index: RBush accelerates hit-testing and marquee operations.
- Practical caps: the app guards against extreme counts (e.g., MAX_CARD_SPRITES is 40,000), but your device’s GPU/RAM will dictate comfortable limits.

Troubleshooting:
- If you see “Graphics context lost,” the app will try to recover automatically; reloading the tab also helps on flaky drivers.
- On very constrained devices, lower the GPU budget via the `gpuBudgetMB` override.

## Architecture overview

- `src/main.ts` — App bootstrap, Pixi stage/world, camera, scene orchestration, overlays, and startup restore.
- `src/scene/` — Card and group visuals, layout, text quality, z-order logic, spatial index integration.
- `src/ui/` — Help panel, theme, inputs, mode toggle, search palette, import/export panel.
- `src/services/` — Scryfall client, image cache, persistence glue, IndexedDB card store.
- `src/state/` — Selection store and UI state; dirty queues for batched updates.
- `src/config/` — Rendering knobs and GPU budget detection.
- `src/search/` — Scryfall-like query parsing for the Search Palette.

## Development

Prereqs: Node 18+ recommended.

Common tasks:

- Start dev server: `npm run dev`
- Typecheck/lint: `npm run lint` or `npm run lint:fix`
- Run tests: `npm test` (vitest)
- Build: `npm run build`

## License

This project is licensed under the Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International License (CC BY-NC-ND 4.0).

- Human-readable summary: https://creativecommons.org/licenses/by-nc-nd/4.0/
- Legal code: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
