// engine.js — render the interactive pricing tool from a deal config, and validate the config.
// This is the Node port of assets/build_html.py + assets/validate_deal.py from the source repo.
// The deal config is the contract: the same JSON drives this renderer AND build_excel.py (parity-locked).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.join(__dirname, '..', 'assets', 'pricing_template.html');

let _template = null;
function template() {
  if (_template == null) _template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return _template;
}

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// json.dumps for inlining inside a <script>: escape </ so no string field can close the script element.
function safeJson(cfg) {
  return JSON.stringify(cfg)
    .replace(/<\//g, "<\\/")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const REQUIRED = ['name', 'slug', 'sectorLabel', 'tiers', 'revenue', 'growth', 'askedPost', 'target'];

// The five anchors the whole model is built on (mirrors SKILL.md Step 0 + validate_deal.py).
const ANCHORS = [
  ['Revenue model (sets the comp set) + sourced tiers', ['sectorLabel', 'tiers']],
  ['Current revenue / ARR', ['revenue']],
  ['Current YoY growth', ['growth']],
  ['Asked valuation (post-money)', ['askedPost']],
  ['Mode (entry vs mark-to-reality)', ['mode']],
];

export function missingAnchors(cfg) {
  const out = [];
  for (const [label, keys] of ANCHORS) {
    const present = keys.some((k) => {
      const v = cfg?.[k];
      return v !== undefined && v !== null && v !== '' && v !== 0 && !(Array.isArray(v) && v.length === 0);
    });
    if (!present) out.push(label);
  }
  return out;
}

export function validateDeal(cfg) {
  const errors = [];
  const warnings = [];
  for (const k of REQUIRED) {
    const v = cfg?.[k];
    if (v === undefined || v === null || v === '') errors.push(`missing required key: ${k}`);
  }
  const tiers = cfg?.tiers;
  if (!Array.isArray(tiers) || tiers.length === 0) {
    errors.push("'tiers' must be a non-empty array of sourced sector medians (high→low by growth)");
  } else {
    tiers.forEach((t, i) => {
      if (!t || t.min == null || !t.name) errors.push(`tiers[${i}] needs at least 'name' and 'min'`);
    });
    const hasMult = tiers.some((t) => t && (t.mult != null || t.exitMult != null));
    if (hasMult && !(cfg.tierSource || (Array.isArray(cfg.sources) && cfg.sources.length))) {
      errors.push("tiers carry sourced multiples but 'tierSource' (provenance) is missing — never show an unsourced multiple");
    }
  }
  if (cfg?.mode != null && !['entry', 'mtr'].includes(cfg.mode)) errors.push("'mode' must be 'entry' or 'mtr'");
  if (cfg?.mode === 'mtr' && !cfg.currentMark) warnings.push("mode is 'mtr' but no 'currentMark' supplied — the mark-gap cannot be computed");

  const own = cfg?.entryOwnership, dil = cfg?.dilution, dOwn = cfg?.dilutedOwnership;
  if (own != null && dil != null && dOwn != null && Math.abs(own * (1 - dil) - dOwn) > 1e-6) {
    warnings.push(`dilutedOwnership ${dOwn} ≠ entryOwnership×(1−dilution) ${(own * (1 - dil)).toFixed(4)} — the engine computes it from entry×(1−dilution); the explicit value is ignored`);
  }
  const wf = cfg?.waterfall;
  if (wf && !wf.start) warnings.push("waterfall has no 'start' ARR — real growth falls back to headline (the cascade won't re-tier)");

  // surface the anchor reminder alongside hard errors, just like the build-time validator
  if (errors.length) {
    const miss = missingAnchors(cfg);
    if (miss.length) errors.push('The model is built on five anchors — still missing: ' + miss.join('; '));
  }
  return { errors, warnings };
}

// Render the standalone interactive tool HTML from a deal config (port of build_html.py).
export function renderTool(cfg) {
  let modeLabel = cfg.mode === 'mtr' ? 'Mark-to-reality' : 'Entry pricing';
  if (cfg._inputs_are_assumptions) modeLabel += ' · INPUTS ARE ASSUMPTIONS';
  const subs = {
    '__DEAL_NAME__': escapeHtml(cfg.name || ''),
    '__ASSET_CLASS__': escapeHtml(cfg.assetClass || ''),
    '__MODE_LABEL__': escapeHtml(modeLabel),
    '__BEDROCK_LABEL__': escapeHtml(cfg.sectorLabel || ''),
    '__BEDROCK_DATE__': escapeHtml(String(cfg.asOf || 'see sources')),
    '__HOLD__': escapeHtml(String(cfg.hold ?? 7)),
    '__TARGET_MOIC__': escapeHtml(String(cfg.target ?? 0)),
    '__DEAL_JSON__': safeJson(cfg),
  };
  // single-pass replacement so a config value can't itself be treated as a placeholder
  const re = new RegExp(Object.keys(subs).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return template().replace(re, (m) => subs[m]);
}

export function slugify(name) {
  return String(name || 'deal').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'deal';
}
