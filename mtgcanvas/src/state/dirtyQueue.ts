import { InstancesRepo } from "../data/repositories";

interface DirtyPos {
  id: number;
  x: number;
  y: number;
}
const dirty = new Map<number, DirtyPos>();
let timer: any = null;

function flush() {
  const batch = [...dirty.values()];
  dirty.clear();
  timer = null;
  if (batch.length) {
    try {
      InstancesRepo.updatePositions(batch);
    } catch {
      // Swallow persistence errors; will retry on next dirty mark
    }
  }
}

export function markDirtyPosition(id: number, x: number, y: number) {
  dirty.set(id, { id, x, y });
  if (!timer) timer = setTimeout(flush, 400);
}

// Testability helpers
export function flushNow() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}
export function resetDirtyQueue() {
  dirty.clear();
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
