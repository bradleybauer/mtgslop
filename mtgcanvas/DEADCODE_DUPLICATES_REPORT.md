Dead Code & Duplicates Cleanup Report

Date: 2025-09-02

Summary
- Scope: mtgcanvas/src
- Goals: remove dead code, consolidate duplication, strengthen typing without behavior change.

Changes

1) Dead code removed
- src/app.ts: Unused entry that only re-imported main.ts; index.html directly loads src/main.ts. No inbound imports or dynamic references.

2) Duplicates consolidated
- snap function: groupNode.ts had a local snap implementation duplicating utils/snap.ts. Replaced with import { snap } from src/utils/snap and parameterized with local GRID_SIZE to preserve behavior.

3) Types strengthened
- Introduced src/types/card.ts exporting a canonical Card type (intersection of ScryfallCard and CardLike) and CardId. This removes several anys:
  - scene/cardNode.ts: CardSprite.__card and CardVisualOptions.card now Card | null. Also adopt CARD_W/CARD_H constants for texture sizing.
  - ui/searchPalette.ts: match(card, ...) now typed as Card instead of any.
  - services/cardStore.ts: addImportedCards/getAllImportedCards now use Card; return types updated.
  - main.ts: fixed strict null access on selected names (s.__card?.name).

Notes on behavior
- No logic changes; only typings and shared utility usage. Constants remain identical values.
- Build and tests should remain green; texture sizing uses same numeric values via shared dimensions.

Deferred items
- main.ts contains many as any casts related to PIXI v8 types and DOM integration. Tightening further is feasible but high‑touch; keeping changes minimal for this pass.
- There are additional any usages in ui/theme.ts and searchPalette.ts for DOM style casts that are safe but noisy; can be incrementally narrowed later.
