import { InstancesRepo } from '../data/repositories';

interface DirtyPos { id:number; x:number; y:number; }
const dirty = new Map<number, DirtyPos>();
let timer: any = null;

function flush() {
  const batch = [...dirty.values()];
  dirty.clear();
  InstancesRepo.updatePositions(batch);
  timer = null;
  // eslint-disable-next-line no-console
  console.log(`Flushed ${batch.length} instances`);
}

export function markDirtyPosition(id:number, x:number, y:number) {
  dirty.set(id, {id,x,y});
  if (!timer) timer = setTimeout(flush, 400);
}
