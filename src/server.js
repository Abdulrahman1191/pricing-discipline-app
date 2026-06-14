// Pricing Discipline — AI-wrapped web app for Raed Ventures.
// Conventions from app-starter (do not change without the admin): listen on $PORT, bind 0.0.0.0,
// trust X-Auth-Email from the platform proxy, service name `app`, join raed_platform network.
//
// Flow: intake form (the five anchors / free-text opportunity) -> Claude classifies the rock and
// assembles a SOURCED deal config -> the app renders the interactive 5-block pricing tool.
// The Anthropic API key comes from the platform env (ANTHROPIC_API_KEY) or the in-app Settings page.

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderTool, validateDeal, slugify, escapeHtml } from './engine.js';
import { buildDealConfig, setApiKey, hasApiKey, keySource } from './claude.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const app = new Hono();

// in-memory store of priced deals: id -> { deal, rationale, assumptions, warnings, by, at }
const DEALS = new Map();
let counter = 0;

/* ---------------- auth (platform proxy) ---------------- */
app.use('*', async (c, next) => {
  if (c.req.path === '/healthz') return next();
  const email = c.req.header('X-Auth-Email') || (process.env.NODE_ENV !== 'production' ? c.req.query('fake_email') : null);
  if (!email) return c.text('unauthorized — request did not pass through the platform proxy', 401);
  c.set('user', { email, name: c.req.header('X-Auth-Name') || email, slackId: c.req.header('X-Auth-Slack-Id') || '' });
  await next();
});

app.get('/healthz', (c) => c.text('ok'));

/* ---------------- layout ---------------- */
function layout(title, body, user) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root{--ink:#0f1419;--mut:#6b7682;--line:#e4e8ed;--bg:#f6f7f9;--card:#fff;--accent:#0b6e6e;--accent2:#0e8a8a;--warm:#b4540a;--bad:#b3261e;--good:#0b7a4b;}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:#0f1719;color:#e9eef0;padding:14px 0;border-bottom:1px solid #1d2a2c}
.hdr{max-width:920px;margin:0 auto;padding:0 22px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.hdr h1{font-size:16px;margin:0;font-weight:650;letter-spacing:-.2px}
.hdr a{color:#8fa3a5;text-decoration:none;font-size:13px}.hdr a:hover{color:#d6e4e5}
.wrap{max-width:920px;margin:0 auto;padding:26px 22px 80px}
a{color:var(--accent2)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:16px}
.lead{color:var(--mut);font-size:13.5px;margin:0 0 18px}
label{display:block;font-size:12px;font-weight:650;color:var(--ink);margin:14px 0 5px;text-transform:uppercase;letter-spacing:.4px}
label .req{color:var(--bad)}
input,select,textarea{width:100%;font:14px/1.4 inherit;padding:9px 11px;border:1px solid var(--line);border-radius:8px;color:var(--ink);background:#fff}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
textarea{min-height:90px;resize:vertical}
.row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
.hint{font-size:11.5px;color:var(--mut);margin-top:3px;font-weight:400;text-transform:none;letter-spacing:0}
.btn{display:inline-block;font:600 14px inherit;padding:11px 20px;border-radius:9px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none}
.btn:hover{background:var(--accent2)}.btn.ghost{background:#fff;color:var(--accent)}
.btnrow{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px}
.note{border-radius:10px;padding:12px 15px;font-size:13px;margin:0 0 16px}
.note.warn{background:#fdf6ea;border:1px solid #f0dcbb;color:#7a4a08}
.note.bad{background:#fdeeed;border:1px solid #f3c9c5;color:#7a1c16}
.note.ok{background:#eefaf2;border:1px solid #bfe6cf;color:#0b5536}
.kv{font-size:12.5px;color:var(--mut)}.kv b{color:var(--ink)}
ul.tight{margin:8px 0 0;padding-left:20px;font-size:13px}ul.tight li{margin-bottom:5px}
h2.sec{font-size:11.5px;text-transform:uppercase;letter-spacing:1px;color:var(--mut);font-weight:700;margin:0 0 10px}
.spin{display:none}
</style></head><body>
<header><div class="hdr"><h1>📐 Pricing Discipline</h1>
<div><a href="/">New deal</a> &nbsp;·&nbsp; <a href="/settings">Settings</a> &nbsp;·&nbsp; <span style="color:#6f8587">${escapeHtml(user?.name || '')}</span></div>
</div></header>
<div class="wrap">${body}</div></body></html>`;
}

/* ---------------- intake form ---------------- */
function formPage(user, { error, missing, values } = {}) {
  const v = values || {};
  const val = (k) => escapeHtml(v[k] ?? '');
  const keyBadge = hasApiKey()
    ? `<span class="kv">Claude key: <b>detected</b> (${escapeHtml(keySource())})</span>`
    : `<span class="kv" style="color:var(--bad)">⚠ No Claude key — <a href="/settings">add one in Settings</a></span>`;
  let banner = '';
  if (error) banner += `<div class="note bad">${escapeHtml(error)}</div>`;
  if (missing && missing.length) {
    banner += `<div class="note warn"><b>The model is built on five anchors — still missing:</b>
      <ul class="tight">${missing.map((m) => `<li>${escapeHtml(m)}</li>`).join('')}</ul>
      Fill them in, or write a fuller description and I'll infer + flag what's assumed.</div>`;
  }
  return layout('Pricing Discipline — New deal', `
  ${banner}
  <div class="card">
    <h2 class="sec">Assess an opportunity</h2>
    <p class="lead">Describe the deal (or fill the five anchors). Claude classifies the revenue model, pulls the <b>sourced</b> public-comp medians for the right sector, and builds the interactive 5-block pricing tool. ${keyBadge}</p>
    <form method="post" action="/price" onsubmit="document.getElementById('go').disabled=true;document.getElementById('go').textContent='Pricing… (Claude is classifying & sourcing — ~20–40s)';">
      <label>Describe the opportunity <span class="hint">free text — the more context, the better. You can rely on this instead of the fields below.</span></label>
      <textarea name="freeText" placeholder="e.g. Oumla — KSA digital-asset infrastructure (custody, tokenization, settlement). Earns a take-rate on settlement volume plus recurring SaaS. ~\$3M ARR, growing ~80% YoY, raising at \$50M post. New deal. We'd write a \$5M check for ~10%.">${val('freeText')}</textarea>

      <h2 class="sec" style="margin-top:22px">The five anchors</h2>
      <div class="row">
        <div><label>Company name</label><input name="name" value="${val('name')}" placeholder="Oumla"></div>
        <div><label>Mode</label><select name="mode">
          <option value="">—</option>
          <option value="entry"${v.mode === 'entry' ? ' selected' : ''}>Entry pricing (new deal)</option>
          <option value="mtr"${v.mode === 'mtr' ? ' selected' : ''}>Mark-to-reality (existing position)</option>
        </select></div>
      </div>
      <label>Revenue model — how it actually makes money <span class="hint">sets the comp set, not the sector label</span></label>
      <input name="revenueModel" value="${val('revenueModel')}" placeholder="take-rate on settlement volume + recurring subscription">
      <div class="row3">
        <div><label>Current revenue / ARR ($M)</label><input name="revenue" value="${val('revenue')}" placeholder="3"></div>
        <div><label>YoY growth (%)</label><input name="growthPct" value="${val('growthPct')}" placeholder="80"></div>
        <div><label>Asked post-money ($M)</label><input name="askedPost" value="${val('askedPost')}" placeholder="50"></div>
      </div>

      <h2 class="sec" style="margin-top:22px">Optional — sharpen the read</h2>
      <div class="row3">
        <div><label>Gross margin (%)</label><input name="gmPct" value="${val('gmPct')}" placeholder="60"></div>
        <div><label>Hold (years)</label><input name="hold" value="${val('hold')}" placeholder="7"></div>
        <div><label>Target MOIC (x)</label><input name="target" value="${val('target')}" placeholder="17"></div>
      </div>
      <div class="row3">
        <div><label>Check size ($M)</label><input name="checkSize" value="${val('checkSize')}" placeholder="5"></div>
        <div><label>Entry ownership (%)</label><input name="ownershipPct" value="${val('ownershipPct')}" placeholder="10"></div>
        <div><label>Future dilution (%)</label><input name="dilutionPct" value="${val('dilutionPct')}" placeholder="50"></div>
      </div>
      <label>Notes <span class="hint">revenue waterfall, NRR trajectory, moat, TAM, three-box — anything else</span></label>
      <textarea name="notes" placeholder="Waterfall ($M): start 3, new 1.2, expansion 0.6, churn 0.2, downgrades 0.1, price 0.8. NRR 125%→118%. Moat: tech 3 / distribution 4 / network 2 / switching 3. TAM ~\$2B.">${val('notes')}</textarea>

      <div class="btnrow"><button id="go" class="btn" type="submit">Build the pricing tool →</button></div>
    </form>
  </div>
  <p class="kv">The deal config Claude produces is the contract — it drives both this interactive tool and the Excel workbook, so the two always agree. Sourced multiples only; anything assumed is flagged.</p>
  `, user);
}

app.get('/', (c) => c.html(formPage(c.get('user'))));

/* ---------------- price (form submit) ---------------- */
app.post('/price', async (c) => {
  const user = c.get('user');
  const b = await c.req.parseBody();
  const input = {
    freeText: b.freeText || '', name: b.name || '', revenueModel: b.revenueModel || '',
    revenue: b.revenue || '', growthPct: b.growthPct || '', askedPost: b.askedPost || '', mode: b.mode || '',
    gmPct: b.gmPct || '', hold: b.hold || '', target: b.target || '', checkSize: b.checkSize || '',
    ownershipPct: b.ownershipPct || '', dilutionPct: b.dilutionPct || '', notes: b.notes || '',
  };

  // five-anchor reminder, built into the app: require either a real description or the structured anchors
  const hasDescription = String(input.freeText).trim().length >= 40;
  if (!hasDescription) {
    const miss = [];
    if (!input.name.trim()) miss.push('Company name');
    if (!input.revenueModel.trim()) miss.push('Revenue model (how it makes money)');
    if (!input.revenue.trim()) miss.push('Current revenue / ARR');
    if (!input.growthPct.trim()) miss.push('Current YoY growth');
    if (!input.askedPost.trim()) miss.push('Asked valuation (post-money)');
    if (!input.mode.trim()) miss.push('Mode (entry vs mark-to-reality)');
    if (miss.length) return c.html(formPage(user, { missing: miss, values: input }));
  }

  if (!hasApiKey()) {
    return c.html(formPage(user, { error: 'No Anthropic API key is configured. The platform normally injects ANTHROPIC_API_KEY; otherwise add one in Settings.', values: input }));
  }

  let result;
  try {
    result = await buildDealConfig(input);
  } catch (e) {
    return c.html(formPage(user, { error: 'Claude could not build the config: ' + e.message, values: input }));
  }

  const { errors, warnings } = validateDeal(result.deal);
  if (errors.length) {
    return c.html(formPage(user, { error: 'The generated config did not validate: ' + errors.join('; '), values: input }));
  }

  const id = `${slugify(result.deal.slug || result.deal.name)}-${++counter}`;
  DEALS.set(id, {
    deal: result.deal, rationale: result.rationale, assumptions: result.assumptions,
    warnings, by: user.email, at: new Date().toISOString(),
  });
  return c.redirect(`/deal/${id}`, 302);
});

/* ---------------- result page ---------------- */
app.get('/deal/:id', (c) => {
  const id = c.req.param('id');
  const rec = DEALS.get(id);
  if (!rec) return c.html(layout('Not found', `<div class="note bad">Deal not found (server may have restarted — in-memory only). <a href="/">Price a new deal</a>.</div>`, c.get('user')), 404);
  const d = rec.deal;
  const assumptionsHtml = rec.assumptions.length
    ? `<ul class="tight">${rec.assumptions.map((a) => `<li>${escapeHtml(a)}</li>`).join('')}</ul>`
    : '<span class="kv">None flagged.</span>';
  const warnHtml = rec.warnings.length
    ? `<div class="note warn"><b>Validation warnings:</b><ul class="tight">${rec.warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('')}</ul></div>` : '';
  return c.html(layout(`Pricing — ${d.name}`, `
    <div class="note ok"><b>${escapeHtml(d.name)}</b> — ${escapeHtml(d.assetClass || '')} · ${d.mode === 'mtr' ? 'Mark-to-reality' : 'Entry pricing'}</div>
    ${warnHtml}
    <div class="card">
      <h2 class="sec">How Claude priced it</h2>
      <p style="margin:0 0 14px">${escapeHtml(rec.rationale)}</p>
      <h2 class="sec">Sector multiples applied <span class="hint" style="text-transform:none;font-weight:400">— ${escapeHtml(d.tierSource || '')}</span></h2>
      <p class="kv" style="margin:0">${(d.tiers || []).map((t) => `<b>${escapeHtml(t.name)}</b> (${t.min > 0 ? '≥' + Math.round(t.min * 100) + '%' : '<10%'}): ${t.mult == null ? 'EV/EBITDA' : t.mult + 'x'}`).join(' &nbsp;·&nbsp; ')}</p>
      <h2 class="sec" style="margin-top:18px">Assumptions to replace with data-room figures</h2>
      ${assumptionsHtml}
      <div class="btnrow">
        <a class="btn" href="/tool/${encodeURIComponent(id)}" target="_blank">Open the interactive tool ↗</a>
        <a class="btn ghost" href="/download/${encodeURIComponent(id)}/html">Download standalone HTML</a>
        <a class="btn ghost" href="/download/${encodeURIComponent(id)}/xlsx">Download Excel</a>
        <a class="btn ghost" href="/api/deal/${encodeURIComponent(id)}" target="_blank">View config JSON</a>
        <a class="btn ghost" href="/">Price another →</a>
      </div>
    </div>
    <p class="kv">Priced by ${escapeHtml(rec.by)} · ${escapeHtml(rec.at)}. The interactive tool gates Block 2→5 behind sign-offs; the cascade re-tiers on real growth and re-bases MOIC on diluted ownership.</p>
  `, c.get('user')));
});

/* ---------------- render the interactive tool ---------------- */
app.get('/tool/:id', (c) => {
  const rec = DEALS.get(c.req.param('id'));
  if (!rec) return c.text('deal not found', 404);
  return c.html(renderTool(rec.deal));
});

app.get('/api/deal/:id', (c) => {
  const rec = DEALS.get(c.req.param('id'));
  if (!rec) return c.json({ error: 'not found' }, 404);
  return c.json(rec.deal);
});

/* ---------------- downloads ---------------- */
app.get('/download/:id/html', (c) => {
  const id = c.req.param('id');
  const rec = DEALS.get(id);
  if (!rec) return c.text('deal not found', 404);
  c.header('Content-Type', 'text/html; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="pricing-${slugify(rec.deal.slug || rec.deal.name)}.html"`);
  return c.body(renderTool(rec.deal));
});

app.get('/download/:id/xlsx', (c) => {
  const id = c.req.param('id');
  const rec = DEALS.get(id);
  if (!rec) return c.text('deal not found', 404);
  const slug = slugify(rec.deal.slug || rec.deal.name);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-'));
  const cfgPath = path.join(tmp, 'deal.json');
  const outPath = path.join(tmp, `pricing-${slug}.xlsx`);
  fs.writeFileSync(cfgPath, JSON.stringify(rec.deal));
  const script = path.join(__dirname, '..', 'assets', 'build_excel.py');
  const py = spawnSync('python3', [script, '--config', cfgPath, '--out', outPath], { encoding: 'utf8' });
  if (py.status !== 0 || !fs.existsSync(outPath)) {
    return c.html(layout('Excel unavailable', `<div class="note warn">Excel generation needs Python + openpyxl on the server (the Docker image installs them). It isn't available here.<br><br><pre class="kv" style="white-space:pre-wrap">${escapeHtml((py.stderr || py.error?.message || 'unknown error').slice(0, 600))}</pre><a href="/deal/${encodeURIComponent(id)}">← back</a></div>`, c.get('user')), 501);
  }
  const buf = fs.readFileSync(outPath);
  c.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  c.header('Content-Disposition', `attachment; filename="pricing-${slug}.xlsx"`);
  return c.body(buf);
});

/* ---------------- settings (API key override) ---------------- */
function settingsPage(user, msg) {
  return layout('Settings', `
  ${msg ? `<div class="note ok">${escapeHtml(msg)}</div>` : ''}
  <div class="card">
    <h2 class="sec">Claude API key</h2>
    <p class="lead">The platform normally injects <code>ANTHROPIC_API_KEY</code> into this app's environment, so this is usually pre-configured. Use this only to override with your own key for this running instance.</p>
    <p class="kv">Current source: <b>${escapeHtml(keySource())}</b></p>
    <form method="post" action="/settings">
      <label>Anthropic API key <span class="hint">stored in memory for this instance only; resets on restart. The durable place is the platform env / .env.</span></label>
      <input name="apiKey" type="password" placeholder="sk-ant-...">
      <div class="btnrow"><button class="btn" type="submit">Save for this instance</button>
      <a class="btn ghost" href="/">← Back</a></div>
    </form>
  </div>`, user);
}
app.get('/settings', (c) => c.html(settingsPage(c.get('user'))));
app.post('/settings', async (c) => {
  const b = await c.req.parseBody();
  setApiKey(b.apiKey || '');
  return c.html(settingsPage(c.get('user'), (b.apiKey ? 'Saved. ' : 'Cleared the override. ') + 'Key source is now: ' + keySource()));
});

serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`pricing-discipline-app listening on :${info.port}`);
});
