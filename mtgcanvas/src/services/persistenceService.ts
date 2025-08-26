import type { CardSprite } from '../scene/cardNode';
import { InstancesRepo, GroupsRepo, type CardInstance, type GroupRow } from '../data/repositories';

export interface LoadedData { instances: CardInstance[]; groups: GroupRow[]; }

export function loadAll(): LoadedData {
  const instances = InstancesRepo.list();
  const groups = GroupsRepo.list();
  return { instances, groups };
}

interface PendingPos { id:number; x:number; y:number; }
const pending = new Map<number, PendingPos>();
let flushTimer: any = null;

export function queuePosition(sprite: CardSprite) {
  pending.set(sprite.__id, { id: sprite.__id, x: sprite.x, y: sprite.y });
  if (!flushTimer) flushTimer = setTimeout(flush, 200);
}

function flush() {
  const batch = [...pending.values()];
  pending.clear(); flushTimer = null;
  try { InstancesRepo.updatePositions(batch); } catch (e) { /* swallow in browser fallback */ }
}
