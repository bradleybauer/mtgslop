import type { CardSprite } from "../scene/cardNode";
import {
  InstancesRepo,
  GroupsRepo,
  type CardInstance,
  type GroupRow,
} from "../data/repositories";

export interface LoadedData {
  instances: CardInstance[];
  groups: (GroupRow & {
    transform?: { x: number; y: number; w: number; h: number };
  })[];
}

export function loadAll(): LoadedData {
  const instances = InstancesRepo.list();
  const groups = GroupsRepo.list().map((g: GroupRow) => ({
    ...g,
    transform: g.transform_json ? safeParse(g.transform_json) : undefined,
  }));
  return { instances, groups };
}

function safeParse(t: string) {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

interface PendingPos {
  id: number;
  x: number;
  y: number;
}
const pending = new Map<number, PendingPos>();
let flushTimer: any = null;

export function queuePosition(sprite: CardSprite) {
  pending.set(sprite.__id, { id: sprite.__id, x: sprite.x, y: sprite.y });
  if (!flushTimer) flushTimer = setTimeout(flush, 200);
}

function flush() {
  const batch = [...pending.values()];
  pending.clear();
  flushTimer = null;
  try {
    InstancesRepo.updatePositions(batch);
  } catch (e) {
    /* swallow in browser fallback */
  }
}

// Group persistence helpers
export function persistGroupTransform(
  id: number,
  t: { x: number; y: number; w: number; h: number },
) {
  try {
    GroupsRepo.updateTransform(id, t);
  } catch {
    /* ignore in fallback */
  }
}
export function persistGroupCollapsed(id: number, collapsed: boolean) {
  try {
    GroupsRepo.setCollapsed(id, collapsed);
  } catch {
    /* */
  }
}
export function persistGroupRename(id: number, name: string) {
  try {
    GroupsRepo.rename(id, name);
  } catch {
    /* */
  }
}
