#!/usr/bin/env tsx
// Scryfall dump importer.
// Supports two formats:
// 1. NDJSON (one JSON object per line)  <-- default (what you currently have)
// 2. Single large JSON array (use --format array)
import { createReadStream, readFileSync } from 'fs';
import * as readline from 'readline';
import { getDb, insertCard } from './db';

interface Args { input: string; limit?: number; format: 'ndjson' | 'array' }

function parseArgs(): Args {
  const inputIndex = process.argv.indexOf('--input');
  if (inputIndex === -1 || !process.argv[inputIndex+1]) {
    console.error('Usage: tsx importer.ts --input path/to/all.json [--limit N] [--format ndjson|array]');
    process.exit(1);
  }
  const limitIndex = process.argv.indexOf('--limit');
  const formatIndex = process.argv.indexOf('--format');
  const limit = limitIndex !== -1 ? parseInt(process.argv[limitIndex+1], 10) : undefined;
  const format = formatIndex !== -1 ? (process.argv[formatIndex+1] as 'ndjson'|'array') : 'ndjson';
  return { input: process.argv[inputIndex+1], limit, format };
}

async function importNdjson(path: string, limit?: number) {
  const rl = readline.createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let count = 0;
  const start = Date.now();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const card = JSON.parse(trimmed);
      insertCard(card);
      count++;
      if (count % 1000 === 0) {
        const elapsed = ((Date.now() - start)/1000).toFixed(1);
        // eslint-disable-next-line no-console
        console.log(`Imported ${count} cards in ${elapsed}s`);
      }
      if (limit && count >= limit) break;
    } catch (e) {
      console.error('Parse error on line', count+1, e);
      process.exit(1);
    }
  }
  console.log(`Done. Imported ${count} cards total.`);
}

function importArray(path: string, limit?: number) {
  const start = Date.now();
  const raw = readFileSync(path, 'utf-8');
  let json: any[];
  try { json = JSON.parse(raw); } catch (e) { console.error('Failed to parse array JSON file.', e); process.exit(1); }
  if (!Array.isArray(json)) { console.error('File does not contain a JSON array.'); process.exit(1); }
  let count = 0;
  for (const card of json) {
    insertCard(card);
    count++;
    if (count % 1000 === 0) {
      const elapsed = ((Date.now() - start)/1000).toFixed(1);
      console.log(`Imported ${count} cards in ${elapsed}s`);
    }
    if (limit && count >= limit) break;
  }
  console.log(`Done. Imported ${count} cards total.`);
}

async function main() {
  const { input, limit, format } = parseArgs();
  getDb();
  if (format === 'array') importArray(input, limit); else await importNdjson(input, limit);
}

main().catch(e => { console.error(e); process.exit(1); });
