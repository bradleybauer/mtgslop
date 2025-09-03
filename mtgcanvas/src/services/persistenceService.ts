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
  InstancesRepo.updatePositions(batch);
}

// Group persistence helpers
export function persistGroupTransform(
  id: number,
  t: { x: number; y: number; w: number; h: number },
) {
  GroupsRepo.updateTransform(id, t);
}
export function persistGroupRename(id: number, name: string) {
  GroupsRepo.rename(id, name);
}
