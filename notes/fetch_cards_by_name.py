#!/usr/bin/env python3
"""
Fetch Scryfall card objects for a newline‑separated list of card names.

Uses the /cards/collection endpoint in efficient batches (max 75 names per
request). Writes one JSON object per line (JSON Lines) by default.

Examples:
  python fetch_cards_by_name.py -i cards.txt -o cards.jsonl

Input file format:
  Each non‑blank line is treated as a card name. Leading/trailing whitespace
  is stripped. Lines beginning with '#' are ignored as comments.

Output formats:
  jsonl (default): one full raw Scryfall card object per line.

Exit codes:
  0 success (even if some cards not found — they are reported on stderr)
  2 input file problems
  3 network / API failures after retries

Notes:
  - If a name cannot be found by exact match, no fuzzy fallback is attempted;
    it will appear in the "not found" list. Adjust names or implement a
    fuzzy follow‑up phase if needed.
  - Duplicate names in the input are de‑duplicated automatically; output will
    still contain only one object per unique card name.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Dict, Iterable, List, Sequence, Tuple
import requests

API_COLLECTION = "https://api.scryfall.com/cards/collection"
BATCH_LIMIT = 75  # Scryfall docs: up to 75 identifiers per request


def read_names(path: str) -> List[str]:
    try:
        with open(path, "r", encoding="utf-8") as fh:
            names = []
            seen = set()
            for line in fh:
                raw = line.strip()
                if not raw or raw.startswith("#"):
                    continue
                if raw not in seen:
                    names.append(raw)
                    seen.add(raw)
            return names
    except OSError as e:
        print(f"Failed to read input file {path}: {e}", file=sys.stderr)
        sys.exit(2)


def chunked(seq: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for i in range(0, len(seq), size):
        yield seq[i : i + size]


def fetch_batch(session: requests.Session, names: Sequence[str], retries: int = 4, backoff_base: float = 1.5):
    payload = {"identifiers": [{"name": n} for n in names]}
    for attempt in range(retries + 1):
        try:
            resp = session.post(API_COLLECTION, json=payload, timeout=40)
            if resp.status_code == 429:  # rate limited
                retry_after = int(resp.headers.get("Retry-After", "1"))
                time.sleep(max(1, retry_after))
                continue
            if resp.status_code >= 400:
                # Try to surface helpful details
                try:
                    err = resp.json().get("details")
                except Exception:
                    err = None
                if err:
                    print(f"Scryfall error {resp.status_code}: {err}", file=sys.stderr)
                resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            if attempt == retries:
                print(f"Network/API error after {retries+1} attempts: {e}", file=sys.stderr)
                sys.exit(3)
            sleep_for = (backoff_base ** attempt)
            time.sleep(sleep_for)
    raise RuntimeError("Unreachable")


def fetch_all(names: List[str], verbose: bool = False) -> Tuple[Dict[str, dict], List[str]]:
    session = requests.Session()
    session.headers.update({"User-Agent": "scryfall-name-fetcher/0.1"})

    results: Dict[str, dict] = {}
    unresolved: set[str] = set()

    for batch_idx, batch in enumerate(chunked(names, BATCH_LIMIT), start=1):
        print(f"Fetching batch {batch_idx} ({len(batch)} names)...", file=sys.stderr)
        data = fetch_batch(session, batch)
        for card in data.get("data", []):
            card_name = card.get("name")
            if card_name:
                results[card_name] = card
        nf = data.get("not_found", [])
        if nf:
            nf_names = [item.get("name") if isinstance(item, dict) else str(item) for item in nf]
            front_face_retry: List[str] = []
            for original in nf_names:
                if " // " in original:
                    front = original.split(" // ", 1)[0].strip()
                    if front:
                        front_face_retry.append(front)
            resolved_this_batch: set[str] = set()
            if front_face_retry:
                retry_set = sorted(set(front_face_retry), key=str.lower)
                if verbose:
                    print(f"    Retrying {len(retry_set)} front-face names...", file=sys.stderr)
                for sub in chunked(retry_set, BATCH_LIMIT):
                    retry_data = fetch_batch(session, sub)
                    for card in retry_data.get("data", []):
                        card_name = card.get("name")
                        if card_name:
                            results[card_name] = card
                # Determine which composite names were satisfied by retry
                results_lower = {n.lower() for n in results.keys()}
                for original in nf_names:
                    if any(original.lower() == r for r in results_lower):
                        resolved_this_batch.add(original)
            # Anything not resolved is truly unresolved (so far)
            still_missing = [n for n in nf_names if n not in resolved_this_batch]
            if still_missing:
                newly_missing = [n for n in still_missing if n not in unresolved]
                unresolved.update(still_missing)
                if newly_missing:
                    print(f"  Newly unresolved: {', '.join(newly_missing)}", file=sys.stderr)
                else:
                    print(f"  Still unresolved: {', '.join(still_missing)}", file=sys.stderr)
            elif verbose:
                print(f"  All initial not-found names resolved after front-face retry ({', '.join(nf_names)})", file=sys.stderr)
    unresolved_sorted = sorted(unresolved, key=str.lower)
    if unresolved_sorted:
        print(f"Total unresolved ({len(unresolved_sorted)}): {', '.join(unresolved_sorted)}", file=sys.stderr)
    return results, unresolved_sorted


def write_raw_lines(cards: List[dict], out_path: str):
    """Write one raw JSON card object per line (JSON Lines), like scryfall.py."""
    outfh = sys.stdout if out_path == "-" else open(out_path, "w", encoding="utf-8")
    try:
        for card in cards:
            outfh.write(json.dumps(card, ensure_ascii=False) + "\n")
    finally:
        if outfh is not sys.stdout:
            outfh.close()


def parse_args(argv: Sequence[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Download Scryfall card data for a list of names.")
    p.add_argument("-i", "--input", required=True, help="Path to newline-separated card names file.")
    p.add_argument("-o", "--out", default="cards.jsonl", help="Output file path or - for stdout.")
    p.add_argument("--sort", choices=["input", "alpha"], default="input", help="Order of cards in output (jsonl).")
    p.add_argument("-v", "--verbose", action="store_true", help="Verbose logging (show successful retries, etc.)")
    return p.parse_args(argv)


def main(argv: Sequence[str] | None = None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    # Infer format from output filename if user didn't explicitly specify
    names = read_names(args.input)
    if not names:
        print("No card names found in input file.", file=sys.stderr)
        return 0

    print(f"Read {len(names)} unique card names.", file=sys.stderr)
    cards, unresolved_names = fetch_all(names, verbose=args.verbose)

    # Build ordered list of card objects using case-insensitive matching to input names.
    lower_map = {k.lower(): v for k, v in cards.items()}

    def resolve_input_name(inp: str):
        lk = inp.lower()
        if lk in lower_map:
            return lower_map[lk]
        if " // " in lk:  # front-face heuristic
            front = lk.split(" // ", 1)[0]
            # try to match any composite whose front matches
            for name_lc, card in lower_map.items():
                if name_lc.startswith(front + " // "):
                    return card
        return None

    ordered_cards: List[dict] = []
    seen_ids = set()
    mapped_names: set[str] = set()
    input_sequence = names if args.sort == "input" else sorted(cards.keys(), key=str.lower)
    for original in input_sequence:
        card = resolve_input_name(original)
        if card:
            mapped_names.add(original)
            cid = card.get("id")
            if cid and cid in seen_ids:
                continue  # avoid duplicate identical card objects
            if cid:
                seen_ids.add(cid)
            ordered_cards.append(card)

    write_raw_lines(ordered_cards, args.out)

    ordering_unresolved = [n for n in names if n not in mapped_names]
    missing_count = len(ordering_unresolved)
    print(
        f"Wrote {len(ordered_cards)} cards (requested {len(names)}, missing {missing_count}) to {args.out} (raw JSON per line)",
        file=sys.stderr,
    )
    combined_unresolved = []
    seen_un = set()
    for name in unresolved_names + ordering_unresolved:
        if name not in seen_un:
            combined_unresolved.append(name)
            seen_un.add(name)
    if combined_unresolved:
        print(
            f"Missing names ({len(combined_unresolved)}): {', '.join(combined_unresolved)}",
            file=sys.stderr,
        )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
