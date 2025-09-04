import type { CardInstance, GroupRow } from "../types/repositories";
import type { Rect } from "../types/geometry";

const mem = { instances: [] as CardInstance[], groups: [] as GroupRow[] };
// Fast id lookup for instances to avoid O(N) scans in hot update paths
const instById = new Map<number, CardInstance>();
let memInstanceId = 1;
let memGroupId = 1;

export const InstancesRepo = {
  create(card_id: number, x: number, y: number) {
    const inst: CardInstance = {
      id: memInstanceId++,
      card_id,
      group_id: null,
      x,
      y,
      z: 0,
      rotation: 0,
      scale: 1,
      tags: null,
    };
    mem.instances.push(inst);
    instById.set(inst.id, inst);
    return inst.id;
  },
  // Memory-only: create an instance with an explicit id (used to restore stable ids). No-op override for DB.
  createWithId(row: {
    id: number;
    card_id: number;
    x: number;
    y: number;
    z?: number;
    rotation?: number;
    scale?: number;
    tags?: string | null;
    group_id?: number | null;
  }) {
    const inst: CardInstance = {
      id: row.id,
      card_id: row.card_id,
      group_id: row.group_id ?? null,
      x: row.x,
      y: row.y,
      z: row.z ?? 0,
      rotation: row.rotation ?? 0,
      scale: row.scale ?? 1,
      tags: row.tags ?? null,
    };
    // Avoid id collisions on subsequent creates
    if (row.id >= memInstanceId) memInstanceId = row.id + 1;
    mem.instances.push(inst);
    instById.set(inst.id, inst);
    return inst.id;
  },
  list() {
    return mem.instances;
  },
  deleteMany(ids: number[]) {
    if (!ids.length) return;
    mem.instances = mem.instances.filter((i) => {
      const keep = !ids.includes(i.id);
      if (!keep) instById.delete(i.id);
      return keep;
    });
  },
  updatePositions(batch: { id: number; x: number; y: number }[]) {
    if (!batch.length) return;
    batch.forEach((r) => {
      const inst = instById.get(r.id);
      if (inst) {
        inst.x = r.x;
        inst.y = r.y;
      }
    });
  },
  updateMany(
    batch: {
      id: number;
      x?: number;
      y?: number;
      z?: number;
      group_id?: number | null;
    }[],
  ) {
    if (!batch.length) return;
    batch.forEach((r) => {
      const inst = instById.get(r.id);
      if (inst) {
        if (r.x !== undefined) inst.x = r.x;
        if (r.y !== undefined) inst.y = r.y;
        if (r.z !== undefined) inst.z = r.z;
        if (r.group_id !== undefined) inst.group_id = r.group_id ?? null;
      }
    });
  },
  // Optional debounced updater for very large batches across a frame.
  updateManyDebounced: (function () {
    let buf: {
      id: number;
      x?: number;
      y?: number;
      z?: number;
      group_id?: number | null;
    }[] = [];
    let timer: any = null;
    function flush() {
      if (!buf.length) return;
      const batch = buf;
      buf = [];
      InstancesRepo.updateMany(batch as any);
    }
    return function queue(
      batch: {
        id: number;
        x?: number;
        y?: number;
        z?: number;
        group_id?: number | null;
      }[],
    ) {
      if (batch && batch.length) buf.push(...batch);
      if (timer) return;
      timer = (globalThis as any).requestAnimationFrame
        ? requestAnimationFrame(() => {
            timer = null;
            flush();
          })
        : setTimeout(() => {
            timer = null;
            flush();
          }, 0);
    };
  })(),
  // Memory-only: ensure the next generated instance id is at least `min`
  ensureNextId(min: number) {
    if (typeof min === "number" && isFinite(min)) {
      if (min > memInstanceId) memInstanceId = min;
    }
  },
};

export const GroupsRepo = {
  create(
    name: string | null,
    parent_id: number | null,
    x: number,
    y: number,
    w: number = 300,
    h: number = 300,
  ) {
    const row: GroupRow = {
      id: memGroupId++,
      parent_id,
      name,
      // collapsed removed
      transform_json: JSON.stringify({ x, y, w, h }),
    };
    mem.groups.push(row);
    return row.id;
  },
  list() {
    return mem.groups as any;
  },
  deleteMany(ids: number[]) {
    if (!ids.length) return;
    mem.groups = mem.groups.filter((g) => !ids.includes(g.id));
  },
  updateTransform(id: number, t: Rect) {
    const json = JSON.stringify(t);
    const g = mem.groups.find((g) => g.id === id);
    if (g) (g as any).transform_json = json;
  },
  // setCollapsed removed
  rename(id: number, name: string) {
    const g = mem.groups.find((g) => g.id === id);
    if (g) g.name = name;
  },
  // Ensure the next generated group id is at least `min`.
  ensureNextId(min: number) {
    if (typeof min === "number" && isFinite(min)) {
      // Bump the counter to avoid collisions with externally restored ids
      if (min > memGroupId) memGroupId = min;
    }
  },
};
