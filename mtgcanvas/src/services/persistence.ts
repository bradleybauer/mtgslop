import type { CardSprite } from "../scene/cardNode";
import type { GroupVisual } from "../scene/groupNode";
import type { SpatialIndex } from "../scene/SpatialIndex";
import { InstancesRepo } from "../data/repositories";

export const LS_POSITIONS_KEY = "mtgcanvas_positions_v1" as const;
export const LS_GROUPS_KEY = "mtgcanvas_groups_v1" as const;

export type PositionsPayload = {
  instances: Array<{
    id: number;
    x: number;
    y: number;
    z: number;
    group_id: number | null;
    scryfall_id?: string | null;
  }>;
  byIndex?: Array<{ x: number; y: number }>;
};

function buildPositionsPayload(sprites: CardSprite[]): PositionsPayload {
  return {
    instances: sprites.map((s) => ({
      id: s.__id,
      x: s.x,
      y: s.y,
      z: (s.zIndex as number) || (s as any).__baseZ || 0,
      group_id: (s as any).__groupId ?? null,
      scryfall_id: (s as any).__scryfallId || ((s as any).__card?.id ?? null),
    })),
    byIndex: sprites.map((s) => ({ x: s.x, y: s.y })),
  };
}

function savePositionsLS(sprites: CardSprite[]) {
  try {
    const data = buildPositionsPayload(sprites);
    // Mirror z into repository for in-memory consistency
    InstancesRepo.updateMany(
      data.instances.map((r) => ({ id: r.id, z: r.z })) as any,
    );
    localStorage.setItem(LS_POSITIONS_KEY, JSON.stringify(data));
  } catch {
    const minimal = {
      instances: sprites.map((s) => ({
        id: s.__id,
        x: s.x,
        y: s.y,
        z: (s.zIndex as number) || (s as any).__baseZ || 0,
        group_id: (s as any).__groupId ?? null,
      })),
    };
    localStorage.setItem(LS_POSITIONS_KEY, JSON.stringify(minimal));
  }
}

function saveGroupsLS(groups: Map<number, GroupVisual>) {
  try {
    const data = {
      groups: [...groups.values()].map((gv) => ({
        id: gv.id,
        x: gv.gfx.x,
        y: gv.gfx.y,
        w: gv.w,
        h: gv.h,
        z: (gv.gfx.zIndex as number) || 0,
        name: gv.name,
        membersById: gv.order.map((s: CardSprite) => s.__id),
      })),
    };
    localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(data));
  } catch {
    const framesOnly = {
      groups: [...groups.values()].map((gv) => ({
        id: gv.id,
        x: gv.gfx.x,
        y: gv.gfx.y,
        w: gv.w,
        h: gv.h,
        z: (gv.gfx.zIndex as number) || 0,
        name: gv.name,
      })),
    };
    localStorage.setItem(LS_GROUPS_KEY, JSON.stringify(framesOnly));
  }
}

export function readMemoryGroupsData(): any | null {
  const raw = localStorage.getItem(LS_GROUPS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function readPositionsData(): any | null {
  const raw = localStorage.getItem(LS_POSITIONS_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function applyStoredPositions(
  sprites: CardSprite[],
  getCanvasBounds: () => { x: number; y: number; w: number; h: number },
  spatial: SpatialIndex,
  cardW: number,
  cardH: number,
) {
  const obj = readPositionsData();
  if (!obj) return;
  if (Array.isArray(obj.instances)) {
    const map = new Map<
      number,
      {
        x: number;
        y: number;
        group_id?: number | null;
        scryfall_id?: string | null;
        z?: number;
      }
    >();
    for (const r of obj.instances) {
      if (typeof r?.id === "number") map.set(r.id, r);
    }
    let matched = 0;
    sprites.forEach((s) => {
      const p = map.get(s.__id);
      if (p) {
        const b = getCanvasBounds();
        s.x = Math.min(b.x + b.w - cardW, Math.max(b.x, p.x));
        s.y = Math.min(b.y + b.h - cardH, Math.max(b.y, p.y));
        if (typeof p.z === "number") {
          s.zIndex = p.z as number;
          (s as any).__baseZ = p.z as number;
        }
        if (p.group_id != null) (s as any).__groupId = p.group_id;
        if (p.scryfall_id) (s as any).__scryfallId = p.scryfall_id;
        matched++;
      }
    });
    if (matched < sprites.length * 0.5 && Array.isArray(obj.byIndex)) {
      obj.byIndex.forEach((p: any, idx: number) => {
        const s = sprites[idx];
        if (s && p && typeof p.x === "number" && typeof p.y === "number") {
          const b = getCanvasBounds();
          s.x = Math.min(b.x + b.w - cardW, Math.max(b.x, p.x));
          s.y = Math.min(b.y + b.h - cardH, Math.max(b.y, p.y));
        }
      });
    }
    sprites.forEach((s) =>
      spatial.update({
        sprite: s,
        minX: s.x,
        minY: s.y,
        maxX: s.x + cardW,
        maxY: s.y + cardH,
      }),
    );
  }
}

export function createLocalPersistence(deps: {
  getSprites: () => CardSprite[];
  getGroups: () => Map<number, GroupVisual>;
  spatial: SpatialIndex;
  getCanvasBounds: () => { x: number; y: number; w: number; h: number };
  cardW: number;
  cardH: number;
}): {
  schedulePositionsSave: () => void;
  flushPositions: () => void;
  scheduleGroupsSave: () => void;
  flushGroups: () => void;
  setSuppressed: (v: boolean) => void;
  applyStoredPositions: () => void;
  getMemoryGroupsData: () => any | null;
} {
  let suppressed = false;
  let posTimer: any = null;
  let groupTimer: any = null;

  function schedulePositionsSave() {
    if (suppressed) return;
    if (posTimer) return;
    posTimer = setTimeout(() => {
      posTimer = null;
      if (suppressed) return;
      savePositionsLS(deps.getSprites());
    }, 350);
  }
  function flushPositions() {
    if (suppressed) {
      posTimer = null;
      return;
    }
    posTimer = null;
    savePositionsLS(deps.getSprites());
  }
  function scheduleGroupsSave() {
    if (suppressed) return;
    if (groupTimer) return;
    groupTimer = setTimeout(() => {
      groupTimer = null;
      if (suppressed) return;
      saveGroupsLS(deps.getGroups());
    }, 400);
  }
  function flushGroups() {
    if (suppressed) {
      groupTimer = null;
      return;
    }
    groupTimer = null;
    saveGroupsLS(deps.getGroups());
  }
  function setSuppressed(v: boolean) {
    suppressed = v;
  }
  function applyStoredPositionsBound() {
    applyStoredPositions(
      deps.getSprites(),
      deps.getCanvasBounds,
      deps.spatial,
      deps.cardW,
      deps.cardH,
    );
  }
  function getMemoryGroupsData() {
    return readMemoryGroupsData();
  }
  return {
    schedulePositionsSave,
    flushPositions,
    scheduleGroupsSave,
    flushGroups,
    setSuppressed,
    applyStoredPositions: applyStoredPositionsBound,
    getMemoryGroupsData,
  };
}
