// Large dataset loader for performance testing without touching persistence DB.
// Attempts to fetch a card universe JSON (prefers legal.json then all.json) placed in public root (vite public/),
// parent dir, or notes/ directory. Spawns synthetic card instances using provided
// factory callback.

interface SpawnOptions {
  count: number;
  batchSize?: number;
  onProgress?: (done: number, total: number) => void;
}
import {
  DATASET_PREFERRED,
  DATASET_FALLBACK,
  datasetCandidatePaths,
} from "../config/dataset";

export function parseUniverseText(txt: string): any[] {
  // Try standard JSON first
  try {
    const parsed = JSON.parse(txt);
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.object === "list" &&
      Array.isArray(parsed.data)
    )
      return parsed.data;
    if (parsed && typeof parsed === "object" && parsed.object === "card")
      return [parsed];
  } catch (_) {
    /* fall through to NDJSON */
  }
  // NDJSON: each line a JSON object
  const lines = txt
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//"));
  const out: any[] = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && obj.object === "card") out.push(obj);
    } catch (_) {
      /* ignore malformed line */
    }
  }
  return out;
}

export async function fetchCardUniverse(): Promise<any[]> {
  // Order matters: prefer the (usually smaller) legal.json subset if present.
  const candidates = datasetCandidatePaths();
  for (const url of candidates) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        console.warn("[largeDataset] fetch failed", url, res.status);
        continue;
      }
      const ct = res.headers.get("content-type") || "unknown";
      // If file is large, attempt streaming NDJSON to avoid huge memory spike.
      if (res.body && !ct.includes("application/json")) {
        // Try stream parse treating as NDJSON
        try {
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = "";
          const out: any[] = [];
          let reading = true;
          while (reading) {
            const { done, value } = await reader.read();
            if (done) {
              reading = false;
              break;
            }
            buf += decoder.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf("\n")) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const obj = JSON.parse(line);
                if (obj && obj.object === "card") {
                  out.push(obj);
                }
              } catch {
                /* ignore */
              }
              if (out.length && out.length % 5000 === 0)
                console.log("[largeDataset] streaming parsed", out.length);
            }
            if (out.length >= 1 && out.length % 20000 === 0) {
              /* yield */
            }
          }
          // Tail
          const tail = buf.trim();
          if (tail) {
            try {
              const obj = JSON.parse(tail);
              if (obj && obj.object === "card") out.push(obj);
            } catch {}
          }
          if (out.length) {
            console.log(
              "[largeDataset] streaming NDJSON load",
              url,
              "count=",
              out.length,
            );
            return out;
          }
        } catch (e) {
          console.warn("[largeDataset] streaming parse failed for", url, e);
        }
      }
      // Full text parse
      const txt = await res.text();
      console.log(
        "[largeDataset] fetched",
        url,
        "size chars=",
        txt.length,
        "preview=",
        txt.slice(0, 80).replace(/\s+/g, " "),
      );
      const arr = parseUniverseText(txt);
      if (arr.length) {
        console.log(
          "[largeDataset] loaded universe from",
          url,
          "count=",
          arr.length,
        );
        return arr;
      } else {
        console.warn("[largeDataset] parse produced 0 cards for", url);
      }
    } catch (err) {
      console.warn("[largeDataset] error fetching candidate", url, err);
    }
  }
  console.warn(
    `[largeDataset] Unable to load ${DATASET_PREFERRED} or ${DATASET_FALLBACK} (place one in mtgcanvas/public/ or notes/)`,
  );
  return [];
}

export async function spawnLargeSet(
  cards: any[],
  create: (inst: {
    id: number;
    x: number;
    y: number;
    z: number;
    card: any;
  }) => void,
  opts: SpawnOptions,
) {
  const total = Math.min(opts.count, cards.length || opts.count);
  const batchSize = opts.batchSize ?? 250;
  let produced = 0;
  const nextIdBase = Date.now();
  // Card dimensions 100x140; choose minimal gaps that preserve grid alignment for GRID_SIZE=8.
  // Need (100+gapX) % 8 === 0 and (140+gapY) % 8 === 0 with smallest >0 -> gapX=4, gapY=4.
  const GAP_X = 4,
    GAP_Y = 4; // keep in sync with main.ts logic
  const GRID_X = 100 + GAP_X;
  const GRID_Y = 140 + GAP_Y;
  const cols = Math.ceil(Math.sqrt(total));
  return new Promise<void>((resolve) => {
    function step() {
      for (let i = 0; i < batchSize && produced < total; i++) {
        const idx = produced;
        const col = idx % cols;
        const row = Math.floor(idx / cols);
        const x = col * GRID_X;
        const y = row * GRID_Y;
        create({
          id: nextIdBase + produced,
          x,
          y,
          z: produced,
          card: cards[idx],
        });
        produced++;
      }
      opts.onProgress && opts.onProgress(produced, total);
      if (produced < total) {
        // Yield to frame; prefer requestIdleCallback if available
        (window as any).requestIdleCallback
          ? (window as any).requestIdleCallback(step)
          : setTimeout(step, 0);
      } else {
        resolve();
      }
    }
    step();
  });
}
