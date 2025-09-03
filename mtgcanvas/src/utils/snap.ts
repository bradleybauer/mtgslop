import { GRID_SIZE } from "../config/dimensions";

/**
 * Snap a value to the nearest GRID_SIZE multiple.
 * Equivalent logic to the previous inline function in main.ts.
 */
export function snap(value: number, gridSize: number = GRID_SIZE): number {
  if (!Number.isFinite(value) || !Number.isFinite(gridSize) || gridSize <= 0) {
    return value;
  }
  return Math.round(value / gridSize) * gridSize;
}
