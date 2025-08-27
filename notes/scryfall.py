#!/usr/bin/env python3
"""
Dump Scryfall /cards/search results as JSON Lines (one raw card object per line).

Usage:
  python scryfall_raw_jsonl.py \
    -q "oracletag:typal id:simic -t:emblem legal:commander" \
    -o simic_typal.jsonl
"""

import argparse
import json
import time
import sys
from typing import Optional
import requests

API_SEARCH = "https://api.scryfall.com/cards/search"

def stream_cards(query: str, unique: str = "cards"):
    session = requests.Session()
    session.headers.update({"User-Agent": "scryfall-jsonl-script/0.1"})
    params = {"q": query, "unique": unique, "order": "name"}

    url: Optional[str] = API_SEARCH
    while url:
        for attempt in range(5):
            try:
                if url == API_SEARCH:
                    resp = session.get(url, params=params, timeout=30)
                else:
                    resp = session.get(url, timeout=30)  # next_page is a full URL
                if resp.status_code == 429:
                    retry = int(resp.headers.get("Retry-After", "1"))
                    time.sleep(max(1, retry))
                    continue
                if resp.status_code >= 400:
                    # Try to extract Scryfall's error details for friendlier output
                    try:
                        err_json = resp.json()
                        details = err_json.get("details") or err_json.get("warning")
                    except Exception:
                        details = None
                    if details:
                        print(f"Scryfall error {resp.status_code}: {details}", file=sys.stderr)
                        # For 4xx other than rate limit, abort early.
                        resp.raise_for_status()
                    else:
                        resp.raise_for_status()
                page = resp.json()
                break
            except requests.RequestException:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)

        for card in page.get("data", []):
            yield card

        url = page.get("next_page") if page.get("has_more") else None

def main():
    ap = argparse.ArgumentParser(description="Write raw Scryfall cards as JSONL.")
    ap.add_argument("-q", "--query", default="oracletag:typal id:simic -t:emblem legal:commander -is:unset",
                    help="Scryfall search string (same as you'd type on the website).")
    ap.add_argument("-o", "--out", default="scryfall_results.jsonl",
                    help="Output jsonl filename.")
    ap.add_argument("--unique", default="cards",
                    choices=["cards", "prints", "art"],
                    help="De-duplication mode (Scryfall 'unique' parameter).")
    ap.add_argument("-Q", "--query-file", metavar="PATH",
                    help="Read the search query text from a file (overrides -q if given). Useful for complex queries containing many -o:/.../ parts that clash with script options.")
    args = ap.parse_args()

    if args.query_file:
        try:
            with open(args.query_file, "r", encoding="utf-8") as qfh:
                # Read whole file; allow multi-line queries (join with spaces)
                file_query = " ".join(line.strip() for line in qfh if line.strip())
                if file_query:
                    args.query = file_query
        except OSError as e:
            print(f"Failed to read query file {args.query_file}: {e}", file=sys.stderr)
            sys.exit(2)

    outfh = sys.stdout if args.out == "-" else open(args.out, "w", encoding="utf-8")

    count = 0
    try:
        for card in stream_cards(args.query, unique=args.unique):
            outfh.write(json.dumps(card, ensure_ascii=False) + "\n")
            count += 1
    finally:
        if outfh is not sys.stdout:
            outfh.close()

    print(f"Wrote {count} rows to {args.out}", file=sys.stderr)

if __name__ == "__main__":
    main()
