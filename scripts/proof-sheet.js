#!/usr/bin/env node
// Proof sheet — pulls a shop's real call/AI/revenue history from the admin API
// and renders it as a printable one-page sales asset plus a console summary.
//
// Usage:
//   ADMIN_KEY=xxx node scripts/proof-sheet.js mad-detailing
//   ADMIN_KEY=xxx SHOPFLOW_URL=https://shopflowtech.com node scripts/proof-sheet.js <slug-or-id> [--out file.html]
//
// SHOPFLOW_URL defaults to the Railway prod host. The numbers come from
// GET /api/admin/shop/:shopKey/proof, which mirrors the owner-dashboard math —
// nothing here is computed client-side, so the sheet can never disagree with
// what the shop sees on their own screen.

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const shopKey = args.find(a => !a.startsWith('--'));
const outFlag = args.indexOf('--out');
const BASE = (process.env.SHOPFLOW_URL || 'https://shopflowio.up.railway.app').replace(/\/$/, '');
const KEY = process.env.ADMIN_KEY;

if (!shopKey || !KEY) {
  console.error('Usage: ADMIN_KEY=xxx [SHOPFLOW_URL=https://...] node scripts/proof-sheet.js <shop-slug-or-id> [--out file.html]');
  process.exit(1);
}

const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = n => '$' + Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';

async function main() {
  const res = await fetch(`${BASE}/api/admin/shop/${encodeURIComponent(shopKey)}/proof`, {
    headers: { 'x-admin-key': KEY },
  });
  if (!res.ok) {
    console.error(`API error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const d = await res.json();
  const { shop, calls, aiFunnel, revenue, responseTime, window: win } = d;

  // ── Console summary ────────────────────────────────────────────────────────
  const line = '─'.repeat(54);
  console.log(`\n${line}\n  PROOF SHEET — ${shop.shopName} (${shop.slug})\n  ${win.days} days of live call history · ${d.timezone}\n${line}`);
  console.log(`  Inbound calls handled        ${calls.total}`);
  console.log(`    answered by staff          ${calls.staffAnswered}`);
  console.log(`    caught by AI receptionist  ${calls.aiHandled}`);
  console.log(`    voicemail fallback         ${calls.voicemail}`);
  console.log(`    after-hours calls          ${calls.afterHours} (${calls.afterHoursAiHandled} handled by AI)`);
  console.log(`  AI funnel  answered ${aiFunnel.answered} → engaged ${aiFunnel.engaged} → quoted ${aiFunnel.quoted} → booked ${aiFunnel.booked} (+${aiFunnel.captured} captured)`);
  console.log(`  Quoted by AI (total)         ${money(aiFunnel.quotedTotal)}`);
  console.log(`  Revenue recovered            ${money(revenue.aiRecoveredTotal)} across ${revenue.aiRecoveredJobs} closed jobs`);
  console.log(`  Open AI pipeline             ${money(revenue.aiPipelineOpen)} across ${revenue.aiPipelineCount} quoted leads`);
  if (responseTime.avgMin != null) console.log(`  Avg first response           ${responseTime.avgMin} min (${responseTime.pctUnder5}% under 5 min, n=${responseTime.sampled})`);
  if (shop.monthlyRate) console.log(`  ROI multiple                 ${(revenue.aiRecoveredTotal / shop.monthlyRate).toFixed(1)}× monthly rate (recovered only)`);
  console.log(line + '\n');

  // ── Printable one-pager ────────────────────────────────────────────────────
  const stat = (label, value, sub) =>
    `<div class="stat"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;

  const transcriptBlocks = (d.topCalls || []).slice(0, 3).map(c => `
    <div class="call">
      <div class="meta"><b>${esc((c.outcome || '').toUpperCase())}</b>${c.quotedPrice ? ' · quoted ' + money(c.quotedPrice) : ''}${c.service ? ' · ' + esc(c.service) : ''}${c.afterHours ? ' · <span class="ah">after hours</span>' : ''}${c.at ? ' · ' + esc(new Date(c.at).toLocaleString('en-US', { timeZone: d.timezone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) : ''}</div>
      ${c.summary ? `<div class="sum">${esc(c.summary)}</div>` : ''}
      <pre>${esc(c.transcript)}</pre>
    </div>`).join('');

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Proof Sheet — ${esc(shop.shopName)}</title>
<style>
  body{font-family:Georgia,serif;color:#17251E;max-width:760px;margin:32px auto;padding:0 24px;line-height:1.5}
  h1{font-family:Arial,Helvetica,sans-serif;font-size:26px;margin:0}
  .sub{color:#5C6B62;font-size:14px;margin:4px 0 20px}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0}
  .stat{border:1px solid #DCE4DE;border-top:3px solid #0E7A54;padding:12px 14px}
  .stat .v{font-family:Arial,Helvetica,sans-serif;font-weight:bold;font-size:24px}
  .stat .l{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#5C6B62;margin-top:2px}
  .stat .s{font-size:12px;color:#5C6B62;margin-top:4px}
  h2{font-family:Arial,Helvetica,sans-serif;font-size:16px;margin:26px 0 8px}
  .funnel{font-family:Arial,Helvetica,sans-serif;font-size:14px;background:#E3F1EA;padding:10px 14px}
  .call{border:1px solid #DCE4DE;padding:10px 14px;margin:10px 0}
  .call .meta{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#0A5F42}
  .call .ah{color:#B45309;font-weight:bold}
  .call .sum{font-size:13px;font-style:italic;color:#5C6B62;margin:4px 0}
  .call pre{white-space:pre-wrap;font-size:12px;background:#F6F8F6;padding:8px 10px;margin:6px 0 0;max-height:180px;overflow:auto}
  .foot{font-size:11px;color:#5C6B62;border-top:1px solid #DCE4DE;margin-top:24px;padding-top:8px}
  @media print{.call pre{max-height:none}}
</style></head><body>
  <h1>Every call answered. Here's the record.</h1>
  <div class="sub">${esc(shop.shopName)} · ${win.days} days of live production call history · generated ${esc(new Date(d.generatedAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }))} · all figures from the shop's own dashboard data</div>
  <div class="grid">
    ${stat('Inbound calls handled', calls.total, calls.staffAnswered + ' by staff · ' + calls.aiHandled + ' by AI')}
    ${stat('Caught after hours', calls.afterHours, calls.afterHoursAiHandled + ' handled live by AI (outside 8–6 / Sun)')}
    ${stat('Would-be missed calls saved', calls.aiHandled, 'calls the AI took when nobody could')}
    ${stat('Quoted by the AI', money(aiFunnel.quotedTotal), aiFunnel.quoted + ' calls left with a price')}
    ${stat('Revenue recovered', money(revenue.aiRecoveredTotal), revenue.aiRecoveredJobs + ' closed jobs traced to AI-caught calls')}
    ${stat('Open pipeline from calls', money(revenue.aiPipelineOpen), revenue.aiPipelineCount + ' quoted leads still in play')}
  </div>
  <h2>The funnel, from the call log</h2>
  <div class="funnel">Answered ${aiFunnel.answered} → engaged ${aiFunnel.engaged} (${pct(aiFunnel.engaged, aiFunnel.answered)}) → quoted ${aiFunnel.quoted} → booked ${aiFunnel.booked} + captured ${aiFunnel.captured}${responseTime.avgMin != null ? ` &nbsp;·&nbsp; avg first response ${responseTime.avgMin} min, ${responseTime.pctUnder5}% under 5` : ''}</div>
  ${transcriptBlocks ? '<h2>Real calls, verbatim</h2>' + transcriptBlocks : ''}
  <div class="foot">Figures computed server-side from ${esc(shop.shopName)}'s production database — the same numbers the owner sees on their ShopFlow dashboard. Customer names/numbers in transcripts should be redacted before external use.</div>
</body></html>`;

  const out = outFlag > -1 && args[outFlag + 1] ? args[outFlag + 1] : `proof-sheet-${shop.slug}.html`;
  fs.writeFileSync(path.resolve(out), html);
  console.log(`Wrote ${out} — open it and print to PDF for the leave-behind.`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
