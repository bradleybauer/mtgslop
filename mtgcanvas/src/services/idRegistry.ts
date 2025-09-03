import type { CardSprite } from "../scene/cardNode";

// Centralized, lightweight id->sprite registry to avoid window globals
let current = new Map<number, CardSprite>();

export function refreshIdMap(sprites: CardSprite[]): Map<number, CardSprite> {
  current = new Map<number, CardSprite>();
  for (let i = 0; i < sprites.length; i++)
    current.set(sprites[i].__id, sprites[i]);
  return current;
}

export function getIdMap(): Map<number, CardSprite> {
  return current;
}

// TODO this is fucking sus
// Prefer this helper for O(1) lookups. Falls back to a local map when registry is empty.
export function getFastIdMap(sprites: CardSprite[]): Map<number, CardSprite> {
  if (current && current.size) return current;
  const idx = new Map<number, CardSprite>();
  for (let i = 0; i < sprites.length; i++) idx.set(sprites[i].__id, sprites[i]);
  return idx;
}
