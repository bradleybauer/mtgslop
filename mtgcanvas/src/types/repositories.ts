import type { Rect } from "./geometry";

export interface CardInstance {
  id: number;
  card_id: number;
  group_id: number | null;
  x: number;
  y: number;
  z: number;
  rotation: number;
  scale: number;
  tags: string | null;
}

export interface GroupRow {
  id: number;
  parent_id: number | null;
  name: string | null;
  // collapsed removed
  transform_json: string | null;
}

export interface InstancesRepository {
  create(card_id: number, x: number, y: number): number;
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
  }): number;
  list(): CardInstance[];
  deleteMany(ids: number[]): void;
  updatePositions(batch: { id: number; x: number; y: number }[]): void;
  updateMany(
    batch: {
      id: number;
      x?: number;
      y?: number;
      z?: number;
      group_id?: number | null;
    }[],
  ): void;
  updateManyDebounced: (
    batch: {
      id: number;
      x?: number;
      y?: number;
      z?: number;
      group_id?: number | null;
    }[],
  ) => void;
  ensureNextId(min: number): void;
}

export interface GroupsRepository {
  create(
    name: string | null,
    parent_id: number | null,
    x: number,
    y: number,
    w?: number,
    h?: number,
  ): number;
  list(): GroupRow[];
  deleteMany(ids: number[]): void;
  updateTransform(id: number, t: Rect): void;
  rename(id: number, name: string): void;
  ensureNextId(min: number): void;
}
