/**
 * Centralized canvas/card sizing and grid spacing constants.
 * These values were previously defined inline in main.ts.
 * Behavior and numeric values are unchanged.
 */

// Global grid size (pixels)
export const GRID_SIZE = 8;

// Base card dimensions (pixels)
export const CARD_W = 100;
export const CARD_H = 140;

// Minimal gaps achieving grid alignment with GRID_SIZE
// To align (CARD + GAP) % GRID_SIZE === 0
export const GAP_X = 4;
export const GAP_Y = 4;

// Derived spacing between cards on X/Y axes
export const SPACING_X = CARD_W + GAP_X;
export const SPACING_Y = CARD_H + GAP_Y;

export type Dimensions = {
  GRID_SIZE: number;
  CARD_W: number;
  CARD_H: number;
  GAP_X: number;
  GAP_Y: number;
  SPACING_X: number;
  SPACING_Y: number;
};

export const DIMENSIONS: Dimensions = {
  GRID_SIZE,
  CARD_W,
  CARD_H,
  GAP_X,
  GAP_Y,
  SPACING_X,
  SPACING_Y,
};
