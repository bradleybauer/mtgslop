#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Iterable, Set, List

POSSIBLE_NAME_COLUMNS = [
    "name", "card_name", "card", "Card Name", "Card", "Name"
]

def read_jsonl_names(path: Path) -> Iterable[str]:
    with path.open("r", encoding="utf-8") as fh:
        for ln, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"JSON parse error line {ln}: {e}", file=sys.stderr)
                continue
            name = obj.get("name")
            if isinstance(name, str):
                yield name


def main(argv: List[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Dump card names from Scryfall results file.")
    ap.add_argument("-i", "--input", required=True, help="Input file (JSONL ).")
    ap.add_argument("-o", "--out", default="-", help="Output file (default stdout).")
    ap.add_argument("--unique", action="store_true", help="Emit each distinct name once.")
    ap.add_argument("--sort", action="store_true", help="Sort names alphabetically before output.")
    args = ap.parse_args(argv)

    in_path = Path(args.input)
    if not in_path.exists():
        print(f"Input file not found: {in_path}", file=sys.stderr)
        return 1

    names_iter = read_jsonl_names(in_path)

    if args.unique:
        seen: Set[str] = set()
        names: List[str] = []
        for n in names_iter:
            if n not in seen:
                seen.add(n)
                names.append(n)
    else:
        names = list(names_iter)

    if args.sort:
        names.sort(key=lambda s: s.lower())

    outfh = sys.stdout if args.out == "-" else open(args.out, "w", encoding="utf-8")
    try:
        for n in names:
            outfh.write(n + "\n")
    finally:
        if outfh is not sys.stdout:
            outfh.close()

    print(f"Wrote {len(names)} names to {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
