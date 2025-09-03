import * as PIXI from "pixi.js";
import type { CardSprite } from "./cardNode";
import {
  createCardSprite,
  beginDragFloat,
  endDragFloat,
  updateDraggedTopLeft,
} from "./cardNode";
import { SelectionStore } from "../state/selectionStore";
import { snap } from "../utils/snap";
import type { Card } from "../types/card";
import type { SpatialIndex, SpatialItem } from "./SpatialIndex";

export type CreateSpriteDeps = {
  renderer: PIXI.Renderer;
  world: PIXI.Container;
  stage: PIXI.Container;
  getAll: () => CardSprite[];
  onDrop: (moved: CardSprite[]) => void;
  onDragMove: (moved: CardSprite[]) => void;
  cardW: number;
  cardH: number;
  isPanning?: () => boolean;
  startMarquee?: (global: PIXI.Point, additive: boolean) => void;
};

export function createSprite(
  inst: {
    id: number;
    x: number;
    y: number;
    z: number;
    group_id?: number | null;
  card?: Card | null;
    scryfall_id?: string | null;
  },
  deps: CreateSpriteDeps,
): CardSprite {
  const s = createCardSprite({
    id: inst.id,
    x: inst.x,
    y: inst.y,
    z: inst.z,
    renderer: deps.renderer,
    card: inst.card,
  });
  if (inst.group_id) (s as any).__groupId = inst.group_id;
  if (inst.scryfall_id) (s as any).__scryfallId = String(inst.scryfall_id);
  else if (inst.card) {
    const sid = (inst.card as any).id || (inst.card as any)?.data?.id;
    if (sid) (s as any).__scryfallId = String(sid);
  }
  (s as any).__cardSprite = true;
  deps.world.addChild(s);
  attachCardInteractions(
    s,
    deps.getAll,
    deps.world,
    deps.stage,
    deps.onDrop,
    deps.isPanning,
    deps.startMarquee,
    deps.onDragMove,
  );
  return s;
}

export function createSpritesBulk(
  items: Array<{
    id: number;
    x: number;
    y: number;
    z: number;
    group_id?: number | null;
    card?: Card | null;
    scryfall_id?: string | null;
  }>,
  deps: CreateSpriteDeps & { spatial: Pick<SpatialIndex, "bulkLoad"> },
): CardSprite[] {
  const created: CardSprite[] = [];
  for (const it of items) {
    const s = createSprite(it, deps);
    created.push(s);
  }
  // Batch insert into spatial index
  deps.spatial.bulkLoad(
    created.map<SpatialItem>((s) => ({
      sprite: s,
      minX: s.x,
      minY: s.y,
      maxX: s.x + deps.cardW,
      maxY: s.y + deps.cardH,
    })),
  );
  return created;
}

function attachCardInteractions(
  s: CardSprite,
  getAll: () => CardSprite[],
  world: PIXI.Container,
  stage: PIXI.Container,
  onDrop?: (moved: CardSprite[]) => void,
  isPanning?: () => boolean,
  startMarquee?: (global: PIXI.Point, additive: boolean) => void,
  onDragMove?: (moved: CardSprite[]) => void,
) {
  // Small movement threshold before we consider a drag (screen-space, conservative)
  const LEFT_DRAG_THRESHOLD_PX = 4;
  let pendingStartLocal: { x: number; y: number } | null = null;
  // Sprites elevated on pointerdown before the drag threshold is crossed
  let preFloatSprites: CardSprite[] | null = null;
  let dragState: null | {
    sprites: CardSprite[];
    // Original positions at drag start (for rigid-body delta application)
    starts: { sprite: CardSprite; x0: number; y0: number }[];
    // Local position where drag started (to compute intended delta)
    startLocal: { x: number; y: number };
    lastGlobalX: number;
    lastTs: number;
  } = null;
  function beginDrag(atLocal: { x: number; y: number }) {
    // Compute selected sprites lazily (only when we actually start dragging)
    const dragSprites: CardSprite[] = SelectionStore.getCards();
    // Raise above current content using global max z; avoid full normalization on drag start
    const w: any = window as any;
    const getMax: any = w.__mtgMaxContentZ;
    let base = (typeof getMax === "function" ? Number(getMax()) : 0) + 1;
    // Stable ordering: keep relative baseZ
    const ordered = dragSprites
      .slice()
      .sort((a, b) => ((a as any).__baseZ || 0) - ((b as any).__baseZ || 0));
    for (const cs of ordered) {
      cs.zIndex = base;
      (cs as any).__baseZ = base;
      base += 1;
    }
    const now = performance.now();
    dragState = {
      sprites: dragSprites,
      starts: dragSprites.map((cs) => {
        const tlx = (cs as any).__tlx ?? cs.x;
        const tly = (cs as any).__tly ?? cs.y;
        return { sprite: cs, x0: tlx, y0: tly };
      }),
      startLocal: { x: atLocal.x, y: atLocal.y },
      lastGlobalX: 0,
      lastTs: now,
    };
    // Engage float/tilt mode for visual feedback
    for (const cs of dragSprites) beginDragFloat(cs);
    // Visual elevation applied above; nothing else to do
  }
  s.on("pointerdown", (e: any) => {
    if (e.button !== 0) return; // only left button selects / drags
    if (isPanning && isPanning()) return; // ignore clicks while panning with space
    // Suppress direct card drag if its group overlay label is active (zoomed out macro view).
    // If Shift held, allow marquee instead of starting a card drag (when user intends multi-select)
    if (e.shiftKey && startMarquee) {
      startMarquee(new PIXI.Point(e.global.x, e.global.y), true);
      return; // don't initiate drag
    }
    if (!e.shiftKey && !SelectionStore.state.cards.has(s)) {
      // Direct click selection should not tint
      (s as any).__tintByMarquee = false;
      SelectionStore.selectOnlyCard(s);
    } else if (e.shiftKey) {
      (s as any).__tintByMarquee = false;
      SelectionStore.toggleCard(s);
    }
    // Record local start; we’ll start drag only after a tiny movement threshold
    const startLocal = world.toLocal(e.global);
    pendingStartLocal = { x: startLocal.x, y: startLocal.y };
  // Immediately elevate currently selected sprites for visual feedback on click-and-hold
  preFloatSprites = SelectionStore.getCards().slice();
  for (const cs of preFloatSprites) beginDragFloat(cs);
  });
  const endDrag = (commit: boolean) => {
    if (!dragState) return;
    // Persist bring-to-front ordering: stack above all existing non-dragging cards
    try {
      const all = getAll ? getAll() : [];
      const draggingIds = new Set(dragState.sprites.map((s) => s.__id));
      let maxZ = 0;
      for (const c of all) {
        if (draggingIds.has(c.__id)) continue;
        const z = c.zIndex || 0;
        if (z > maxZ) maxZ = z;
      }
      // Stable assignment order: promote in ascending previous baseZ to preserve relative stacking
      const sorted = dragState.sprites.slice().sort((a, b) => {
        const az = (a as any).__baseZ || 0;
        const bz = (b as any).__baseZ || 0;
        return az - bz;
      });
      for (const cs of sorted) {
        maxZ += 1;
        cs.zIndex = maxZ;
        (cs as any).__baseZ = maxZ;
      }
    } catch {
      // Fallback: restore baseZ if computation fails
      dragState.sprites.forEach((cs) => (cs.zIndex = cs.__baseZ));
    }
  if (commit) {
      // Snap/clamp moved sprites to grid and within canvas bounds; persistence is handled
      // by the onDrop callback (main schedules a centralized save).
      const ha: any = (stage as any).hitArea as any;
      const hasBounds = ha && typeof ha.x === "number";
      const minX = hasBounds ? ha.x : -Infinity;
      const minY = hasBounds ? ha.y : -Infinity;
      const maxX = hasBounds ? ha.x + ha.width - 100 : Infinity;
      const maxY = hasBounds ? ha.y + ha.height - 140 : Infinity;
      dragState.sprites.forEach((cs) => {
        // Exit float mode and restore TL-based transform before snapping
        endDragFloat(cs);
        let nx = snap(cs.x);
        let ny = snap(cs.y);
        if (hasBounds) {
          if (nx < minX) nx = minX;
          if (ny < minY) ny = minY;
          if (nx > maxX) nx = maxX;
          if (ny > maxY) ny = maxY;
        }
        cs.x = nx;
        cs.y = ny;
      });
  onDrop && onDrop(dragState.sprites);
    }
    dragState = null;
  };
  stage.on("pointerup", () => {
    const hadDrag = !!dragState;
    pendingStartLocal = null;
    endDrag(!!dragState);
    if (!hadDrag && preFloatSprites) {
      // No drag occurred; end pre-float elevation cleanly
      for (const cs of preFloatSprites) endDragFloat(cs);
    }
    preFloatSprites = null;
  });
  stage.on("pointerupoutside", () => {
    const hadDrag = !!dragState;
    pendingStartLocal = null;
    endDrag(!!dragState);
    if (!hadDrag && preFloatSprites) {
      for (const cs of preFloatSprites) endDragFloat(cs);
    }
    preFloatSprites = null;
  });
  stage.on("pointermove", (e: any) => {
    // If we have a pending click and no drag yet, check if movement exceeds threshold to begin drag
    if (!dragState && pendingStartLocal) {
      const localNow = world.toLocal(e.global);
      // Convert world-space delta to screen-space approx using stage scale
      const sc = (world as any)?.scale?.x || 1;
      const dx = (localNow.x - pendingStartLocal.x) * sc;
      const dy = (localNow.y - pendingStartLocal.y) * sc;
      if (Math.hypot(dx, dy) >= LEFT_DRAG_THRESHOLD_PX) {
  beginDrag(localNow);
        // Now that a real drag has begun, clear pre-float tracker
        preFloatSprites = null;
        // fall-through to apply first move below in same tick
      } else {
        return;
      }
    }
    if (!dragState) return;
  const local = world.toLocal(e.global);
    let moved = false;
    const ha: any = (stage as any).hitArea as any;
    const hasBounds = ha && typeof ha.x === "number";
    const minX = hasBounds ? ha.x : -Infinity;
    const minY = hasBounds ? ha.y : -Infinity;
    const maxX = hasBounds ? ha.x + ha.width - 100 : Infinity;
    const maxY = hasBounds ? ha.y + ha.height - 140 : Infinity;

  // Intended deltas from drag start
    let dX = local.x - dragState.startLocal.x;
    let dY = local.y - dragState.startLocal.y;

    if (hasBounds) {
      // Compute shared delta limits so that all sprites remain in-bounds
      let lowDX = -Infinity;
      let highDX = Infinity;
      let lowDY = -Infinity;
      let highDY = Infinity;
      for (const st of dragState.starts) {
        // For X: minX <= x0 + dX <= maxX
        lowDX = Math.max(lowDX, minX - st.x0);
        highDX = Math.min(highDX, maxX - st.x0);
        // For Y: minY <= y0 + dY <= maxY
        lowDY = Math.max(lowDY, minY - st.y0);
        highDY = Math.min(highDY, maxY - st.y0);
      }
      // Clamp intended delta to allowable range
      if (dX < lowDX) dX = lowDX;
      if (dX > highDX) dX = highDX;
      if (dY < lowDY) dY = lowDY;
      if (dY > highDY) dY = highDY;
    }

    for (const st of dragState.starts) {
      const nx = st.x0 + dX;
      const ny = st.y0 + dY;
      // Always drive by top-left during drag to keep continuity with float's TL snapshot
      if (st.sprite.__tiltActive) {
        updateDraggedTopLeft(st.sprite, nx, ny);
        moved = true;
      } else if (st.sprite.x !== nx || st.sprite.y !== ny) {
        st.sprite.x = nx;
        st.sprite.y = ny;
        moved = true;
      }
    }
    if (moved && onDragMove) onDragMove(dragState.sprites);
  });
}
