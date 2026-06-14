#!/usr/bin/env python3
"""
validate_deal.py — shared deal-config validation, imported by build_html.py and build_excel.py.

The model is generic: a new opportunity is priced by dropping in a JSON config, never by editing
a template. This guard enforces the model's rules so that flexibility never becomes fabrication:
sourced multiples must carry provenance, ownership must be internally consistent, etc.

Usage (library):  from validate_deal import check ; errors, warnings = check(cfg)
Usage (CLI):       python validate_deal.py examples/oumla.deal.json
`check(..., strict=True)` raises SystemExit on hard errors; warnings are returned for the caller to print.
"""
import json, sys

REQUIRED = ["name", "slug", "sectorLabel", "tiers", "revenue", "growth", "askedPost", "target"]

# The five anchors the model is built on (Step 0 of SKILL.md). Each maps to the config key(s) that
# carry it, so a config that skipped an anchor fails the build with the SAME reminder the skill gives.
ANCHORS = [
    ("Revenue model (sets the comp set) + sourced tiers", ("sectorLabel", "tiers")),
    ("Current revenue / ARR", ("revenue",)),
    ("Current YoY growth", ("growth",)),
    ("Asked valuation (post-money)", ("askedPost",)),
    ("Mode (entry vs mark-to-reality)", ("mode",)),
]


def missing_anchors(cfg):
    """Return the list of human-readable anchors that are absent from the config."""
    out = []
    for label, keys in ANCHORS:
        if not any(cfg.get(k) not in (None, "", 0, []) for k in keys):
            out.append(label)
    return out


def check(cfg, *, strict=True):
    """Return (errors, warnings). Raises SystemExit on hard errors when strict=True."""
    errors, warnings = [], []

    for k in REQUIRED:
        if cfg.get(k) in (None, ""):
            errors.append(f"missing required key: {k!r}")

    tiers = cfg.get("tiers")
    if not isinstance(tiers, list) or not tiers:
        errors.append("'tiers' must be a non-empty list of sourced sector medians (high->low by growth)")
    else:
        for i, t in enumerate(tiers):
            if not isinstance(t, dict) or "min" not in t or "name" not in t:
                errors.append(f"tiers[{i}] needs at least 'name' and 'min'")
        mins = [t.get("min", 0) for t in tiers if isinstance(t, dict)]
        if mins and mins != sorted(mins, reverse=True):
            warnings.append("tiers are not sorted high->low by 'min' (auto-sorted at build time — fix the config to be safe)")
        # sourcing rule: any non-null multiple must carry provenance
        has_mult = any(
            isinstance(t, dict) and (t.get("mult") is not None or t.get("exitMult") is not None)
            for t in tiers
        )
        if has_mult and not (cfg.get("tierSource") or cfg.get("sources")):
            errors.append("tiers carry sourced multiples but 'tierSource' (provenance) is missing — "
                          "never show an unsourced multiple")

    if cfg.get("mode") not in (None, "entry", "mtr"):
        errors.append("'mode' must be 'entry' or 'mtr'")
    if cfg.get("mode") == "mtr" and not cfg.get("currentMark"):
        warnings.append("mode is 'mtr' but no 'currentMark' supplied — the mark-gap cannot be computed")

    for k in ("revenue", "askedPost", "target"):
        v = cfg.get(k)
        if isinstance(v, (int, float)) and v <= 0:
            warnings.append(f"{k} is {v} (expected > 0)")

    own, dil, d_own = cfg.get("entryOwnership"), cfg.get("dilution"), cfg.get("dilutedOwnership")
    if own is not None and dil is not None and d_own is not None:
        if abs(own * (1 - dil) - d_own) > 1e-6:
            warnings.append(
                f"dilutedOwnership {d_own} != entryOwnership x (1 - dilution) {own * (1 - dil):.4f} — "
                "both engines compute it from entry x (1 - dilution); the explicit value is ignored"
            )

    wf = cfg.get("waterfall") or {}
    if wf and not wf.get("start"):
        warnings.append("waterfall has no 'start' ARR — real growth will fall back to headline (the cascade won't re-tier)")

    if errors and strict:
        msg = "deal config invalid:\n  - " + "\n  - ".join(errors)
        miss = missing_anchors(cfg)
        if miss:
            msg += ("\n\nThe model is built on five anchors — still missing:\n  - "
                    + "\n  - ".join(miss)
                    + "\nProvide these (the skill's Step 0) and the build will proceed.")
        raise SystemExit(msg)
    return errors, warnings


def main():
    if len(sys.argv) != 2:
        print("usage: python validate_deal.py <deal.json>", file=sys.stderr); sys.exit(2)
    cfg = json.load(open(sys.argv[1], encoding="utf-8"))
    errors, warnings = check(cfg, strict=False)
    for w in warnings: print("warning:", w)
    if errors:
        print("INVALID:"); [print("  -", e) for e in errors]; sys.exit(1)
    print(f"OK — {cfg.get('name','(unnamed)')} validates ({len(warnings)} warning(s))")


if __name__ == "__main__":
    main()
