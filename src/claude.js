// claude.js — the AI wrapper. Turns an opportunity description + anchors into a sourced deal config
// by calling Claude (claude-opus-4-8, adaptive thinking) with the pricing system prompt and a
// structured-output schema. The API key comes from the platform env (ANTHROPIC_API_KEY) or an
// in-app /settings override — everything runs inside the application.

import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT, DEAL_SCHEMA } from './knowledge.js';

const MODEL = 'claude-opus-4-8';

let runtimeKey = null; // in-memory override set via /settings; resets on restart

export function setApiKey(k) { runtimeKey = (k && k.trim()) || null; }
export function resolveKey() { return runtimeKey || process.env.ANTHROPIC_API_KEY || null; }
export function hasApiKey() { return Boolean(resolveKey()); }
export function keySource() {
  if (runtimeKey) return 'in-app override';
  if (process.env.ANTHROPIC_API_KEY) return 'platform environment (ANTHROPIC_API_KEY)';
  return 'none — set one in Settings or via the platform';
}

function client() {
  const apiKey = resolveKey();
  if (!apiKey) throw new Error('No Anthropic API key available. The platform normally injects ANTHROPIC_API_KEY; otherwise add one in Settings.');
  return new Anthropic({ apiKey });
}

function userMessage(input) {
  // input is the parsed intake form (anchors + optional fields + free-text notes)
  const lines = [];
  if (input.freeText && input.freeText.trim()) {
    lines.push('Opportunity description:');
    lines.push(input.freeText.trim());
    lines.push('');
  }
  const field = (label, v) => { if (v !== undefined && v !== null && String(v).trim() !== '') lines.push(`- ${label}: ${v}`); };
  lines.push('Structured anchors provided (blank = infer or flag as assumption):');
  field('Company name', input.name);
  field('Revenue model (how it makes money)', input.revenueModel);
  field('Current revenue / ARR ($M)', input.revenue);
  field('Current YoY growth (%)', input.growthPct);
  field('Asked post-money ($M)', input.askedPost);
  field('Mode', input.mode);
  field('Gross margin (%)', input.gmPct);
  field('Hold (years)', input.hold);
  field('Target MOIC (x)', input.target);
  field('Check size ($M)', input.checkSize);
  field('Entry ownership (%)', input.ownershipPct);
  field('Future dilution (%)', input.dilutionPct);
  field('Notes (waterfall / NRR / moat / TAM / three-box, anything else)', input.notes);
  lines.push('');
  lines.push('Classify the rock, pull the sourced tier multiples, assemble the deal config, and flag every assumption.');
  return lines.join('\n');
}

export async function buildDealConfig(input) {
  const c = client();
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'high', format: { type: 'json_schema', schema: DEAL_SCHEMA } },
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage(input) }],
  });
  if (resp.stop_reason === 'refusal') {
    throw new Error('The model declined to price this opportunity.');
  }
  const textBlock = resp.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('The model returned no text output.');
  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (e) {
    throw new Error('The model did not return valid JSON: ' + e.message);
  }
  return {
    rationale: parsed.rationale || '',
    assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
    deal: parsed.deal || {},
    usage: resp.usage || null,
  };
}
