# Deal Config Schema — the contract for assessing any opportunity

The model is **generic**. To price a new opportunity you never edit the template or the engines — you
supply **one JSON config** describing the deal, and both renderers (`build_html.py`, `build_excel.py`)
read it. The config *is* how you share an opportunity with the model.

There are three ways to produce that config (pick by situation):

1. **Conversational (default).** Describe the opportunity to Claude with the `pricing-discipline` skill
   active. Give the anchors below; Claude classifies the revenue model, picks + confirms the sector and
   its **sourced** tier multiples (per `SKILL.md` Step 1b and `sourced-multiples.md`), assembles the JSON,
   validates it, and renders. You don't hand-write JSON.
2. **Structured (repeatable / auditable).** Copy `examples/_TEMPLATE.deal.json` to
   `examples/<slug>.deal.json`, fill it, and run the build scripts. Best when you already have the numbers
   (data room) or want a versioned artifact per deal.
3. **Live extraction (Co-Work / PitchBook).** When a browser/connector is available, the skill pulls
   company financials and sector comp **medians** straight from your entitled PitchBook session into the
   `tiers` array, with provenance.

`validate_deal.py` runs on every build and **fails** if a sourced multiple lacks `tierSource`, if required
keys are missing, or if tiers are malformed — so flexibility never becomes fabrication.

---

## The minimum to start (Block 1)

| Field | Type | Meaning |
|---|---|---|
| `name`, `slug` | string | identity (slug used in filenames) |
| `assetClass` | string | human-readable label shown in the header |
| `sectorLabel` | string | which sector's multiples to apply |
| `tiers` | array | **the sourced multiples** (see below) — required |
| `tierSource` | string | provenance for the multiples (source + as-of + URL). Required if any `mult` is set |
| `revenue` | number | current revenue / ARR, $M |
| `growth` | number (fraction) | headline YoY growth, e.g. `0.45` = 45% |
| `askedPost` | number | asked post-money valuation, $M |
| `target` | number | target MOIC, e.g. `5` |
| `hold` | number | hold years (Raed default 7) |
| `gm` | number (fraction) | gross margin, e.g. `0.75` |
| `mode` | `"entry"` \| `"mtr"` | new deal vs mark-to-reality |
| `decay` | number (fraction) | annual growth-decay rate (default `0.85`) |

### `tiers` — the sourced multiples (the heart of the model)

```json
"tiers": [
  {"name":"Hypergrowth","min":0.40,"mult":22.0,"exitMult":22.0},
  {"name":"High","min":0.30,"mult":16.0,"exitMult":16.0},
  {"name":"Mid","min":0.20,"mult":14.2,"exitMult":14.2},
  {"name":"Slow","min":0.10,"mult":8.0,"exitMult":8.0},
  {"name":"Mature","min":0.00,"mult":null,"exitMult":null}
]
```

- `min` = lower growth bound for the tier (fraction). Tiers may be listed in any order — both engines
  sort high→low defensively.
- `mult` = **sourced public-comp MEDIAN** EV/Revenue for that growth tier in this sector. Never an
  average, never a single ticker, never fabricated. If you can't source it, leave it `null`.
- `exitMult` = the multiple a company decayed *into* that tier exits at. Omit to default to `mult`.
- `mult: null` (typically Mature) → the sector is valued on **EV/EBITDA**, and the tool flags an
  "FCF exit" (no revenue multiple at exit).

## Block 2 — Growth Quality (the cascade driver)

| Field | Type | Meaning |
|---|---|---|
| `waterfall` | object | `{start, new, exp, churn, down, price}` in $M. **real growth = (new + exp − churn − down) / start** — this re-tiers the entry multiple and drives the cascade. `price` increases are "fake" growth, excluded. |
| `nrr0`, `nrr1` | number (percent) | NRR two years ago vs today, as percents (e.g. `130`, `110`) — the maiming test |
| `tam` | number | stated TAM, $M (1%-rule + entry-vs-TAM checks) |
| `targetArr` | number | target ARR, $M (penetration check) |

> If `waterfall.start` is 0/absent, real growth falls back to headline and the cascade does not re-tier.
> Supplying the waterfall is what makes the model more than a single-number calculator.

## Block 3 — Capital

| Field | Type | Meaning |
|---|---|---|
| `burn` | number | net burn over 12M, $M |
| `netNewArr` | number | net new ARR over 12M, $M (with `gm`, gives the GM-adjusted burn multiple) |
| `checkSize` | number | your check, $M |
| `entryOwnership` | number (fraction) | entry stake, e.g. `0.12` |
| `dilution` | number (fraction) | future dilution to exit, e.g. `0.5` |
| `fundSize` | number | fund size, $M (fund-returner math) |

> **Diluted ownership is computed as `entryOwnership × (1 − dilution)`** in both engines. A separate
> `dilutedOwnership` field is *ignored* (kept only for back-compat); the validator warns if it disagrees.

## Block 4 — Defensibility

| Field | Type | Meaning |
|---|---|---|
| `moat` | array[4] | `[Technology, Distribution, Network effects, Switching costs]`, each 1–5 |
| `erosion` | string | `"slow"` \| `"moderate"` \| `"fast"` — fast pushes decay toward 0.72 on Block-4 sign-off |
| `convergenceLayer` | string | `"consolidating agent"` \| `"point solution"` \| `"surviving infra"` |
| `integAvg`, `integPct` | number | avg integrations/customer; % of customers using 3+ |

## Block 5 — Decision

| Field | Type | Meaning |
|---|---|---|
| `threeBox` | object | `{market, team, risk}` booleans — the gate |

## Mark-to-reality & cosmetic

| Field | Type | Meaning |
|---|---|---|
| `currentMark` | number | last-round mark, $M (only used when `mode:"mtr"`) |
| `heatLo`, `heatHi` | number | heatmap colour scaling (cosmetic) |
| `asOf` | string | as-of date shown in the header |
| `_inputs_are_assumptions` | string | set when inputs are assumptions, not data-room figures — shows an "ASSUMPTIONS" banner |
| `sources` | array \| null | optional override of the numbered source registry |
| `benchmarkLibrary` | array \| null | optional reference cards on the Benchmarking tab |

---

## Rules the validator enforces

- Required: `name`, `slug`, `sectorLabel`, `tiers`, `revenue`, `growth`, `askedPost`, `target`.
- Any non-null `mult`/`exitMult` ⇒ `tierSource` (provenance) is **required**.
- `mode` ∈ {`entry`, `mtr`}; `mtr` warns if `currentMark` is missing.
- Warns when `dilutedOwnership` ≠ `entryOwnership × (1 − dilution)`, and when a waterfall has no `start`.

Unknown keys (and `_comment`-style notes) are ignored, so you can annotate configs freely.
