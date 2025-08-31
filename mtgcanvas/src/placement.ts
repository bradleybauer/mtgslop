import RBush from "rbush";
import type * as PIXI from "pixi.js";
import type { CardSprite } from "./scene/cardNode";
import type { GroupVisual } from "./scene/groupNode";

export type Rect = { x: number; y: number; w: number; h: number };
export interface PlacementContext {
  sprites: CardSprite[];
  groups: Map<number, GroupVisual>;
  world: PIXI.Container;
  getCanvasBounds: () => { x: number; y: number; w: number; h: number };
  gridSize: number;
  cardW: number;
  cardH: number;
  gapX: number;
  gapY: number;
  spacingX: number;
  spacingY: number;
}

const snap = (v: number, grid: number) => Math.round(v / grid) * grid;
// Unified padding used across RBush queries, fallback collision, and occupancy dilation
const PAD = 8;

type BushItem = {
  id: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function buildObstacleIndex(ctx: PlacementContext, extra: Rect[] = []) {
  const tree = new RBush<BushItem>();
  let id = 1;
  // Groups
  ctx.groups.forEach((eg) => {
    tree.insert({
      id: id++,
      minX: eg.gfx.x,
      minY: eg.gfx.y,
      maxX: eg.gfx.x + eg.w,
      maxY: eg.gfx.y + eg.h,
    });
  });
  // Cards
  for (const s of ctx.sprites) {
    tree.insert({
      id: id++,
      minX: s.x,
      minY: s.y,
      maxX: s.x + ctx.cardW,
      maxY: s.y + ctx.cardH,
    });
  }
  // Extra placed (during planning)
  for (const r of extra) {
    tree.insert({
      id: id++,
      minX: r.x,
      minY: r.y,
      maxX: r.x + r.w,
      maxY: r.y + r.h,
    });
  }
  return tree;
}

function rectOverlapsIndex(
  tree: RBush<BushItem>,
  x: number,
  y: number,
  w: number,
  h: number,
  pad = PAD,
) {
  const res = tree.search({
    minX: x - pad,
    minY: y - pad,
    maxX: x + w + pad,
    maxY: y + h + pad,
  });
  return res.length > 0;
}

class MinHeap<T> {
  // Use a secondary sequence number to ensure deterministic ordering for equal keys
  private a: { k: number; s: number; v: T }[] = [];
  private seq = 0;
  constructor(private cap = 4096) {}
  size() {
    return this.a.length;
  }
  push(k: number, v: T) {
    const a = this.a;
    a.push({ k, s: this.seq++, v });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].k < a[i].k) break;
      if (a[p].k === a[i].k && a[p].s <= a[i].s) break;
      const tmp = a[p];
      a[p] = a[i];
      a[i] = tmp;
      i = p;
    }
    if (a.length > this.cap) this.cap *= 2;
  }
  pop(): T | undefined {
    const a = this.a;
    if (a.length === 0) return undefined;
    const out = a[0].v;
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (
          l < a.length &&
          (a[l].k < a[m].k || (a[l].k === a[m].k && a[l].s < a[m].s))
        )
          m = l;
        if (
          r < a.length &&
          (a[r].k < a[m].k || (a[r].k === a[m].k && a[r].s < a[m].s))
        )
          m = r;
        if (m === i) break;
        const tmp = a[m];
        a[m] = a[i];
        a[i] = tmp;
        i = m;
      }
    }
    return out;
  }
}

function bestFirstFreeSpot(
  ctx: PlacementContext,
  desiredX: number,
  desiredY: number,
  w: number,
  h: number,
  tree: RBush<BushItem>,
  pad = PAD,
) {
  const b = ctx.getCanvasBounds();
  // Start at desired center clamped and snapped
  const sx0 = Math.min(
    Math.max(b.x, snap(desiredX, ctx.gridSize)),
    b.x + b.w - w,
  );
  const sy0 = Math.min(
    Math.max(b.y, snap(desiredY, ctx.gridSize)),
    b.y + b.h - h,
  );
  const centerX = sx0 + w / 2;
  const centerY = sy0 + h / 2;
  // Multi-resolution expansion: start coarse, refine down to gridSize
  let stepX = snap(Math.max(w + 40, 200), ctx.gridSize);
  let stepY = snap(Math.max(h + 40, 180), ctx.gridSize);
  for (;;) {
    const heap = new MinHeap<{ x: number; y: number }>();
    const seen = new Set<string>();
    const bLocal = b;
    const key = (x: number, y: number) => {
      return x + "," + y;
    };
    const push = (x: number, y: number) => {
      let cx = snap(x, ctx.gridSize);
      let cy = snap(y, ctx.gridSize);
      cx = Math.min(Math.max(bLocal.x, cx), bLocal.x + bLocal.w - w);
      cy = Math.min(Math.max(bLocal.y, cy), bLocal.y + bLocal.h - h);
      const k = key(cx, cy);
      if (seen.has(k)) return;
      seen.add(k);
      const dx = cx + w / 2 - centerX;
      const dy = cy + h / 2 - centerY;
      heap.push(dx * dx + dy * dy, { x: cx, y: cy });
    };
    push(sx0, sy0);
    let expansions = 0;
    const maxExpansions = 20000;
    while (heap.size() && expansions++ < maxExpansions) {
      const cur = heap.pop()!;
      if (!rectOverlapsIndex(tree, cur.x, cur.y, w, h, pad)) return cur;
      // 8-connected expansion at current resolution
      push(cur.x + stepX, cur.y);
      push(cur.x - stepX, cur.y);
      push(cur.x, cur.y + stepY);
      push(cur.x, cur.y - stepY);
      push(cur.x + stepX, cur.y + stepY);
      push(cur.x + stepX, cur.y - stepY);
      push(cur.x - stepX, cur.y + stepY);
      push(cur.x - stepX, cur.y - stepY);
    }
    // Refine resolution
    const nStepX = Math.max(ctx.gridSize, Math.floor(stepX / 2));
    const nStepY = Math.max(ctx.gridSize, Math.floor(stepY / 2));
    if (nStepX === stepX && nStepY === stepY) break;
    stepX = nStepX;
    stepY = nStepY;
  }
  // Give up (no non-overlapping spot at any resolution)
  return null;
}

export function computeBestGrid(n: number, ctx: PlacementContext) {
  let bestCols = 1;
  let bestRows = n;
  let bestW = bestRows * ctx.cardW + (bestRows - 1) * ctx.gapX;
  let bestH = ctx.cardH;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const w = c * ctx.cardW + (c - 1) * ctx.gapX;
    const h = r * ctx.cardH + (r - 1) * ctx.gapY;
    let score = Math.abs(w - h);
    const lastRowCount = n - (r - 1) * c;
    const underfill = c > 0 ? (c - lastRowCount) / c : 0;
    score += underfill * Math.min(ctx.cardW, ctx.cardH) * 0.2;
    if (score < bestScore) {
      bestScore = score;
      bestCols = c;
      bestRows = r;
      bestW = w;
      bestH = h;
    }
  }
  return { cols: bestCols, rows: bestRows, w: bestW, h: bestH };
}

export function findFreeSpotForBlock(
  w: number,
  h: number,
  ctx: PlacementContext,
  opts?: { pad?: number },
): { x: number; y: number } | null {
  const pad = opts?.pad ?? PAD;
  const b = ctx.getCanvasBounds();
  // If the canvas is empty, center the block within world bounds for a sensible default
  if (ctx.sprites.length === 0) {
    let cx = snap(Math.round(b.x + (b.w - w) / 2), ctx.gridSize);
    let cy = snap(Math.round(b.y + (b.h - h) / 2), ctx.gridSize);
    cx = Math.min(Math.max(b.x, cx), b.x + b.w - w);
    cy = Math.min(Math.max(b.y, cy), b.y + b.h - h);
    return { x: cx, y: cy };
  }
  // Prefer placement near the viewport center or nearby existing content
  let desiredX = b.x + b.w / 2 - w / 2;
  let desiredY = b.y + b.h / 2 - h / 2;
  try {
    const stage = (ctx.world.parent as any) || null;
    const screenCenter = {
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    } as any;
    const local = (ctx.world as any).toLocal
      ? (ctx.world as any).toLocal(screenCenter, stage)
      : null;
    if (local && typeof local.x === "number") {
      desiredX = local.x - w / 2;
      desiredY = local.y - h / 2;
    }
  } catch {}
  // Try a best-first search around the desired center using an obstacle index
  try {
    const tree = buildObstacleIndex(ctx);
    const spot = bestFirstFreeSpot(ctx, desiredX, desiredY, w, h, tree, pad);
    if (spot && !rectOverlapsIndex(tree, spot.x, spot.y, w, h, pad))
      return spot;
  } catch {}
  // Exhaustive grid scan at gridSize resolution; return null if none found
  const di = Math.max(ctx.gridSize, Math.floor(ctx.spacingX / 2));
  const dj = Math.max(ctx.gridSize, Math.floor(ctx.spacingY / 2));
  for (let y = b.y; y <= b.y + b.h - h; y += dj) {
    for (let x = b.x; x <= b.x + b.w - w; x += di) {
      const sx = snap(x, ctx.gridSize);
      const sy = snap(y, ctx.gridSize);
      let collides = false;
      for (const eg of ctx.groups.values()) {
        const x1 = eg.gfx.x - pad,
          y1 = eg.gfx.y - pad,
          x2 = eg.gfx.x + eg.w + pad,
          y2 = eg.gfx.y + eg.h + pad;
        if (sx < x2 && sx + w > x1 && sy < y2 && sy + h > y1) {
          collides = true;
          break;
        }
      }
      if (!collides) {
        for (const s of ctx.sprites) {
          const x1 = s.x - pad,
            y1 = s.y - pad,
            x2 = s.x + ctx.cardW + pad,
            y2 = s.y + ctx.cardH + pad;
          if (sx < x2 && sx + w > x1 && sy < y2 && sy + h > y1) {
            collides = true;
            break;
          }
        }
      }
      if (!collides) return { x: sx, y: sy };
    }
  }
  return null;
}

export function planPackedBlockPositions(n: number, ctx: PlacementContext) {
  const ratio = ctx.spacingY / ctx.spacingX;
  const cols = Math.max(4, Math.round(Math.sqrt(n * ratio)));
  const rows = Math.max(1, Math.ceil(n / cols));
  const blockW = cols * ctx.spacingX - ctx.gapX;
  const blockH = rows * ctx.spacingY - ctx.gapY;
  const anchor = findFreeSpotForBlock(blockW, blockH, ctx, { pad: PAD });
  if (!anchor)
    return { positions: [], block: { x: 0, y: 0, w: blockW, h: blockH } };
  const positions: { x: number; y: number }[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    positions[i] = {
      x: anchor.x + c * ctx.spacingX,
      y: anchor.y + r * ctx.spacingY,
    };
  }
  return {
    positions,
    block: { x: anchor.x, y: anchor.y, w: blockW, h: blockH },
  };
}

function buildOccupancyGrid(ctx: PlacementContext) {
  const b = ctx.getCanvasBounds();
  const originX = snap(b.x, ctx.gridSize);
  const originY = snap(b.y, ctx.gridSize);
  const cols = Math.max(1, Math.floor(b.w / ctx.spacingX));
  const rows = Math.max(1, Math.floor(b.h / ctx.spacingY));
  const occ = new Uint8Array(cols * rows);
  const idx = (i: number, j: number) => j * cols + i;
  const clampI = (i: number) => Math.min(Math.max(0, i), cols - 1);
  const clampJ = (j: number) => Math.min(Math.max(0, j), rows - 1);
  const di = Math.ceil(PAD / ctx.spacingX);
  const dj = Math.ceil(PAD / ctx.spacingY);
  // Mark groups
  ctx.groups.forEach((g) => {
    const x1 = g.gfx.x,
      y1 = g.gfx.y,
      x2 = g.gfx.x + g.w,
      y2 = g.gfx.y + g.h;
    const i0 = clampI(Math.floor((x1 - originX) / ctx.spacingX) - di);
    const i1 = clampI(Math.ceil((x2 - originX) / ctx.spacingX) - 1 + di);
    const j0 = clampJ(Math.floor((y1 - originY) / ctx.spacingY) - dj);
    const j1 = clampJ(Math.ceil((y2 - originY) / ctx.spacingY) - 1 + dj);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) occ[idx(i, j)] = 1;
  });
  // Mark cards
  for (const s of ctx.sprites) {
    const x1 = s.x,
      y1 = s.y,
      x2 = s.x + ctx.cardW,
      y2 = s.y + ctx.cardH;
    const i0 = clampI(Math.floor((x1 - originX) / ctx.spacingX) - di);
    const i1 = clampI(Math.ceil((x2 - originX) / ctx.spacingX) - 1 + di);
    const j0 = clampJ(Math.floor((y1 - originY) / ctx.spacingY) - dj);
    const j1 = clampJ(Math.ceil((y2 - originY) / ctx.spacingY) - 1 + dj);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) occ[idx(i, j)] = 1;
  }
  // Prefix sum (integral image) for O(1) rectangle sums
  const sums = new Int32Array((cols + 1) * (rows + 1));
  const S = (i: number, j: number) => sums[j * (cols + 1) + i];
  for (let j = 1; j <= rows; j++) {
    let rowSum = 0;
    for (let i = 1; i <= cols; i++) {
      rowSum += occ[idx(i - 1, j - 1)];
      sums[j * (cols + 1) + i] = S(i, j - 1) + rowSum;
    }
  }
  function rectSum(i0: number, j0: number, i1: number, j1: number) {
    // inclusive bounds in cell indices
    i0 = Math.max(0, i0);
    j0 = Math.max(0, j0);
    i1 = Math.min(cols - 1, i1);
    j1 = Math.min(rows - 1, j1);
    const a = S(i0, j0);
    const b2 = S(i1 + 1, j0);
    const c = S(i0, j1 + 1);
    const d = S(i1 + 1, j1 + 1);
    return d - b2 - c + a;
  }
  return { originX, originY, cols, rows, occ, sums, rectSum };
}

function planFlowAroundPositions(
  n: number,
  ctx: PlacementContext,
  seed?: { i: number; j: number },
) {
  const { originX, originY, cols, rows, occ, rectSum } =
    buildOccupancyGrid(ctx);
  const idx = (i: number, j: number) => j * cols + i;
  const clampI = (i: number) => Math.min(Math.max(0, i), cols - 1);
  const clampJ = (j: number) => Math.min(Math.max(0, j), rows - 1);
  // Seed center
  let ci0: number, cj0: number;
  if (seed) {
    ci0 = clampI(seed.i);
    cj0 = clampJ(seed.j);
  } else if (ctx.sprites.length) {
    let ax = 0,
      ay = 0;
    for (const s of ctx.sprites) {
      ax += s.x + ctx.cardW / 2;
      ay += s.y + ctx.cardH / 2;
    }
    ax /= ctx.sprites.length;
    ay /= ctx.sprites.length;
    ci0 = clampI(Math.floor((ax - originX) / ctx.spacingX));
    cj0 = clampJ(Math.floor((ay - originY) / ctx.spacingY));
  } else {
    ci0 = Math.floor(cols / 2);
    cj0 = Math.floor(rows / 2);
  }
  // Target dims from grid heuristic
  const { cols: tCols, rows: tRows } = computeBestGrid(n, ctx);
  let c = Math.max(1, Math.min(tCols, cols));
  let r = Math.max(1, Math.min(tRows, rows));
  const targetAspect = tCols / Math.max(1, tRows);
  // Expand rectangle until we have >= n free cells
  function rectBounds(ci: number, cj: number, w: number, h: number) {
    // Centered at (ci,cj), half extents floor(w/2), floor(h/2)
    const halfW = Math.floor(w / 2);
    const halfH = Math.floor(h / 2);
    const i0 = clampI(ci - halfW);
    const i1 = clampI(ci + (w - 1 - halfW));
    const j0 = clampJ(cj - halfH);
    const j1 = clampJ(cj + (h - 1 - halfH));
    // Effective dims after clamping
    const ew = i1 - i0 + 1;
    const eh = j1 - j0 + 1;
    return { i0, i1, j0, j1, ew, eh };
  }
  let b = rectBounds(ci0, cj0, c, r);
  let area = b.ew * b.eh;
  let occCount = rectSum(b.i0, b.j0, b.i1, b.j1);
  let free = area - occCount;
  let guard = 0;
  while (free < n && guard++ < cols + rows) {
    // Decide whether to expand width or height to stay squareish
    const expandWidthScore = Math.abs((b.ew + 1) / b.eh - targetAspect);
    const expandHeightScore = Math.abs(b.ew / (b.eh + 1) - targetAspect);
    if (expandWidthScore <= expandHeightScore) c = Math.min(cols, b.ew + 1);
    else r = Math.min(rows, b.eh + 1);
    b = rectBounds(ci0, cj0, c, r);
    area = b.ew * b.eh;
    occCount = rectSum(b.i0, b.j0, b.i1, b.j1);
    free = area - occCount;
    if (b.ew >= cols && b.eh >= rows) break;
  }
  if (free <= 0) return planPackedBlockPositions(n, ctx);
  // Collect free cells inside rectangle; prefer nearest to center by Chebyshev distance
  const candidates: { i: number; j: number; d: number }[] = [];
  for (let j = b.j0; j <= b.j1; j++) {
    for (let i = b.i0; i <= b.i1; i++) {
      if (occ[idx(i, j)]) continue;
      const d = Math.max(Math.abs(i - ci0), Math.abs(j - cj0));
      candidates.push({ i, j, d });
    }
  }
  // Deterministic tie-breakers: prefer smaller j then smaller i
  candidates.sort((a, b2) => a.d - b2.d || a.j - b2.j || a.i - b2.i);
  const positions: { x: number; y: number }[] = [];
  let minX = Number.POSITIVE_INFINITY,
    minY = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    maxY = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < Math.min(n, candidates.length); k++) {
    const { i, j } = candidates[k];
    const x = originX + i * ctx.spacingX;
    const y = originY + j * ctx.spacingY;
    positions.push({ x, y });
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + ctx.cardW);
    maxY = Math.max(maxY, y + ctx.cardH);
  }
  // If still not enough (heavy occupancy), expand outward adding more rectangles
  let ring = 1;
  while (
    positions.length < n &&
    (b.ew + ring <= cols || b.eh + ring <= rows) &&
    ring < cols + rows
  ) {
    const extra = rectBounds(ci0, cj0, b.ew + ring, b.eh + ring);
    for (let j = extra.j0; j <= extra.j1 && positions.length < n; j++) {
      for (let i = extra.i0; i <= extra.i1 && positions.length < n; i++) {
        if (i >= b.i0 && i <= b.i1 && j >= b.j0 && j <= b.j1) continue; // skip inner
        if (occ[idx(i, j)]) continue;
        const x = originX + i * ctx.spacingX;
        const y = originY + j * ctx.spacingY;
        positions.push({ x, y });
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + ctx.cardW);
        maxY = Math.max(maxY, y + ctx.cardH);
      }
    }
    ring++;
  }
  if (!positions.length) return planPackedBlockPositions(n, ctx);
  if (!Number.isFinite(minX)) {
    minX = positions[0].x;
    minY = positions[0].y;
    maxX = positions[0].x + ctx.cardW;
    maxY = positions[0].y + ctx.cardH;
  }
  let block = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  // Top-up if still short: keep expanding search area (no overlapping packed fallback)
  if (positions.length < n) {
    // Scan entire grid, prefer closer to seed by Chebyshev distance
    const extras: { i: number; j: number; d: number }[] = [];
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        if (occ[idx(i, j)]) continue;
        const d = Math.max(Math.abs(i - ci0), Math.abs(j - cj0));
        extras.push({ i, j, d });
      }
    }
    // Deterministic tie-breakers: prefer smaller j then smaller i
    extras.sort((a, b3) => a.d - b3.d || a.j - b3.j || a.i - b3.i);
    for (const e of extras) {
      if (positions.length >= n) break;
      const x = originX + e.i * ctx.spacingX;
      const y = originY + e.j * ctx.spacingY;
      positions.push({ x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + ctx.cardW);
      maxY = Math.max(maxY, y + ctx.cardH);
    }
    block = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  return { positions, block };
}

export function planImportPositions(n: number, ctx: PlacementContext) {
  if (ctx.sprites.length === 0) return planPackedBlockPositions(n, ctx);
  // Large imports: try block placement with minimal overlap first
  const { cols: bCols, rows: bRows, w, h } = computeBestGrid(n, ctx);
  const { originX, originY, cols, rows, rectSum } = buildOccupancyGrid(ctx);
  // Centroid in grid coords
  let ax = 0,
    ay = 0;
  for (const s of ctx.sprites) {
    ax += s.x + ctx.cardW / 2;
    ay += s.y + ctx.cardH / 2;
  }
  ax /= ctx.sprites.length || 1;
  ay /= ctx.sprites.length || 1;
  const ci = Math.min(
    Math.max(0, Math.floor((ax - originX) / ctx.spacingX)),
    cols - 1,
  );
  const cj = Math.min(
    Math.max(0, Math.floor((ay - originY) / ctx.spacingY)),
    rows - 1,
  );
  const maxI = Math.max(0, cols - bCols);
  const maxJ = Math.max(0, rows - bRows);
  // Try the exact centered anchor first
  const centerI = Math.min(Math.max(0, Math.floor(ci - bCols / 2)), maxI);
  const centerJ = Math.min(Math.max(0, Math.floor(cj - bRows / 2)), maxJ);
  let bestI = centerI,
    bestJ = centerJ,
    bestOverlap = rectSum(
      centerI,
      centerJ,
      centerI + bCols - 1,
      centerJ + bRows - 1,
    ),
    bestScore = bestOverlap * 1000000 + 0;
  const WEIGHT_FLOW = 1000000; // strongly prefer fewer overlaps
  const WEIGHT_DIST = 1; // light bias toward centroid locality
  for (let j = 0; j <= maxJ; j++) {
    for (let i = 0; i <= maxI; i++) {
      const overlap = rectSum(i, j, i + bCols - 1, j + bRows - 1);
      const dx = i + bCols * 0.5 - ci;
      const dy = j + bRows * 0.5 - cj;
      const score = overlap * WEIGHT_FLOW + (dx * dx + dy * dy) * WEIGHT_DIST;
      if (score < bestScore) {
        bestScore = score;
        bestOverlap = overlap;
        bestI = i;
        bestJ = j;
      }
    }
  }
  // If we found an empty block, pack there
  if (bestOverlap === 0) {
    const anchorX = originX + bestI * ctx.spacingX;
    const anchorY = originY + bestJ * ctx.spacingY;
    const positions: { x: number; y: number }[] = new Array(n);
    for (let k = 0; k < n; k++) {
      const c = k % bCols;
      const r = Math.floor(k / bCols);
      positions[k] = {
        x: anchorX + c * ctx.spacingX,
        y: anchorY + r * ctx.spacingY,
      };
    }
    const out: { positions: { x: number; y: number }[]; block: Rect } = {
      positions,
      block: { x: anchorX, y: anchorY, w, h },
    };
    return out as any;
  }
  // Always seed flow-around at best-overlap anchor; lexicographic scoring already handled
  return planFlowAroundPositions(n, ctx, { i: bestI, j: bestJ });
}

// Generic rectangle planner: place arbitrary rectangles near a seed while avoiding existing cards and groups.
// Returns positions in the same order as input rects.
export function planRectangles(
  rects: { w: number; h: number }[],
  ctx: PlacementContext,
  opts?: {
    pad?: number;
    seed?: { x: number; y: number };
    labels?: (string | number)[]; // same length as rects; items with same label attract
    attractStrength?: number; // 0..1, how much to bias toward label centroid
    preserveOrder?: boolean; // if true, do not reorder rects
    excludeGroupIds?: number[]; // skip these group ids when seeding obstacles
    obstacleMode?: "all" | "cardsOnly"; // default 'all'
    excludeSpriteGroupIds?: number[]; // skip cards whose __groupId is in this list
    desiredSeeds?: ({ x: number; y: number } | undefined | null)[]; // optional per-rect desired centers
  },
) {
  const pad = opts?.pad ?? PAD;
  const b = ctx.getCanvasBounds();
  // Build obstacle index once and insert placed rectangles as we go
  const tree = new RBush<BushItem>();
  let id = 1;
  const exclude = new Set<number>(opts?.excludeGroupIds || []);
  const includeGroups = (opts?.obstacleMode || "all") === "all";
  // Existing groups (unless excluded or cardsOnly mode)
  if (includeGroups)
    ctx.groups.forEach((eg) => {
      if (exclude.has(eg.id)) return;
      tree.insert({
        id: id++,
        minX: eg.gfx.x,
        minY: eg.gfx.y,
        maxX: eg.gfx.x + eg.w,
        maxY: eg.gfx.y + eg.h,
      });
    });
  // Existing cards
  const excludeSpriteGroups = new Set<number>(
    opts?.excludeSpriteGroupIds || [],
  );
  for (const s of ctx.sprites) {
    const gid = (s as any).__groupId as number | undefined;
    if (gid != null && excludeSpriteGroups.has(gid)) continue;
    tree.insert({
      id: id++,
      minX: s.x,
      minY: s.y,
      maxX: s.x + ctx.cardW,
      maxY: s.y + ctx.cardH,
    });
  }
  // Seed (desired center)
  let desiredX = b.x + b.w / 2;
  let desiredY = b.y + b.h / 2;
  if (opts?.seed) {
    desiredX = opts.seed.x;
    desiredY = opts.seed.y;
  } else {
    try {
      const stage = (ctx.world.parent as any) || null;
      const screenCenter = {
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      } as any;
      const local = (ctx.world as any).toLocal
        ? (ctx.world as any).toLocal(screenCenter, stage)
        : null;
      if (local && typeof local.x === "number") {
        desiredX = local.x;
        desiredY = local.y;
      }
    } catch {}
  }
  // Determine placement order
  const order = opts?.preserveOrder
    ? rects.map((_, i) => i)
    : rects
        .map((r, i) => ({
          i,
          a: r.w * r.h,
          l: opts?.labels ? opts.labels[i] : undefined,
        }))
        .sort((x, y) => {
          if (x.l !== undefined && y.l !== undefined) {
            if (x.l < y.l) return -1;
            if (x.l > y.l) return 1;
          } else if (x.l !== undefined) return -1;
          else if (y.l !== undefined) return 1;
          // Prefer larger area first; tie-break by original index for determinism
          return y.a - x.a || x.i - y.i;
        })
        .map((o) => o.i);
  const out: { x: number; y: number }[] = new Array(rects.length);
  // Track centroids for labels of already-placed rects
  const labelAgg = new Map<
    string | number,
    { sx: number; sy: number; c: number }
  >();
  let minX = Number.POSITIVE_INFINITY,
    minY = Number.POSITIVE_INFINITY,
    maxX = Number.NEGATIVE_INFINITY,
    maxY = Number.NEGATIVE_INFINITY;
  for (const idx of order) {
    const r = rects[idx];
    // Adjust desired by label centroid if available
    const sd =
      opts?.desiredSeeds && opts.desiredSeeds[idx]
        ? (opts.desiredSeeds[idx] as { x: number; y: number })
        : { x: desiredX, y: desiredY };
    let dX = sd.x;
    let dY = sd.y;
    const label = opts?.labels ? opts.labels[idx] : undefined;
    const strength = Math.min(1, Math.max(0, opts?.attractStrength ?? 0));
    if (label !== undefined && strength > 0) {
      const agg = labelAgg.get(label);
      if (agg && agg.c > 0) {
        const cx = agg.sx / agg.c;
        const cy = agg.sy / agg.c;
        dX = (1 - strength) * dX + strength * cx;
        dY = (1 - strength) * dY + strength * cy;
      }
    }
    const spot = bestFirstFreeSpot(
      ctx,
      dX - r.w / 2,
      dY - r.h / 2,
      r.w,
      r.h,
      tree,
      pad,
    );
    // Fallback: coarse grid scan
    let pos = spot as { x: number; y: number } | null;
    if (!pos) {
      const di = Math.max(ctx.gridSize, Math.floor(ctx.spacingX / 2));
      const dj = Math.max(ctx.gridSize, Math.floor(ctx.spacingY / 2));
      outer: for (let y = b.y; y <= b.y + b.h - r.h; y += dj) {
        for (let x = b.x; x <= b.x + b.w - r.w; x += di) {
          const sx = snap(x, ctx.gridSize);
          const sy = snap(y, ctx.gridSize);
          if (!rectOverlapsIndex(tree, sx, sy, r.w, r.h, pad)) {
            pos = { x: sx, y: sy } as any;
            break outer;
          }
        }
      }
    }
    if (!pos) {
      // If still not found, place at clamped desired as last resort
      const cx = Math.min(
        Math.max(b.x, snap(Math.round(desiredX - r.w / 2), ctx.gridSize)),
        b.x + b.w - r.w,
      );
      const cy = Math.min(
        Math.max(b.y, snap(Math.round(desiredY - r.h / 2), ctx.gridSize)),
        b.y + b.h - r.h,
      );
      pos = { x: cx, y: cy } as any;
    }
    // At this point pos is guaranteed by fallback above
    const px = (pos as { x: number; y: number }).x;
    const py = (pos as { x: number; y: number }).y;
    out[idx] = { x: px, y: py };
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px + r.w > maxX) maxX = px + r.w;
    if (py + r.h > maxY) maxY = py + r.h;
    // Insert into obstacle index
    tree.insert({
      id: id++,
      minX: px,
      minY: py,
      maxX: px + r.w,
      maxY: py + r.h,
    });
    // Update label centroid with center of placed rect
    if (label !== undefined) {
      const cx = px + r.w / 2;
      const cy = py + r.h / 2;
      const agg = labelAgg.get(label) || { sx: 0, sy: 0, c: 0 };
      agg.sx += cx;
      agg.sy += cy;
      agg.c += 1;
      labelAgg.set(label, agg);
    }
  }
  if (!Number.isFinite(minX)) {
    return { positions: out, block: { x: b.x, y: b.y, w: 0, h: 0 } } as any;
  }
  return {
    positions: out,
    block: { x: minX, y: minY, w: maxX - minX, h: maxY - minY },
  } as any;
}
