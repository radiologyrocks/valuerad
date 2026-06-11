#!/usr/bin/env node
/**
 * Seed the running dev server with realistic demo data so the Command Center
 * is useful the instant it loads — instead of the empty "walls of buttons"
 * first-run. Drives the real HTTP API (same RBAC + audit as a human), so it
 * works against the in-memory dev store with no database.
 *
 *   cd server && npm run dev          # terminal 1 (port 3001)
 *   cd server && npm run seed         # terminal 2
 *
 * Idempotent-ish: re-running re-ingests (datasets use replace) and skips
 * items/principals that already exist. Override the target with
 * VALUERAD_API_BASE. Dev identity via headers (admin+executive).
 */

const BASE = process.env.VALUERAD_API_BASE ?? 'http://localhost:3001';
const HEADERS = {
  'Content-Type': 'application/json',
  'X-ValueRad-User': 'demo@valuerad.com',
  'X-ValueRad-Roles': 'executive,admin,scheduler,auth_specialist',
};

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: HEADERS,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  return { ok: res.ok, status: res.status, data };
}

function log(step, detail = '') {
  console.log(`  ${step}${detail ? ` — ${detail}` : ''}`);
}

// --- demo datasets (CSV, the format a practice actually exports) ----------
const CSV = {
  claims:
    'payer,status,expected,paid,arDays,denialReason,modality\n' +
    'Aetna,paid,1200,1180,21,,MR\nAetna,paid,800,790,28,,CT\n' +
    'BCBS,denied,1200,0,96,No prior auth,MR\nBCBS,paid,800,640,52,,CT\n' +
    'Cigna,paid,250,250,17,,US\nCigna,denied,3000,0,74,Not medically necessary,PET\n' +
    'Medicare,paid,600,600,24,,CT\nMedicare,paid,80,80,15,,XR\n' +
    'UnitedHealth,paid,1200,1080,33,,MR\nUnitedHealth,denied,800,0,61,Coding error,CT',
  studies:
    'modality,orderedAt,finalAt,radiologistId,rvu\n' +
    'MR,2026-06-01T08:00:00Z,2026-06-01T19:00:00Z,rad-neuro,2.5\n' +
    'MR,2026-06-02T08:00:00Z,2026-06-03T16:00:00Z,rad-neuro,2.5\n' +
    'CT,2026-06-02T09:00:00Z,2026-06-02T15:00:00Z,rad-body,1.8\n' +
    'CT,2026-06-03T09:00:00Z,2026-06-03T13:00:00Z,rad-body,1.8\n' +
    'US,2026-06-03T10:00:00Z,2026-06-03T12:00:00Z,rad-body,0.7\n' +
    'XR,2026-06-04T10:00:00Z,2026-06-04T11:00:00Z,rad-msk,0.3',
  appointments:
    'status\ncompleted\ncompleted\ncompleted\ncompleted\narrived\nnoshow\ncancelled\nbooked',
  slots:
    'durationMin,status,modality\n45,completed,MR\n45,completed,MR\n45,booked,MR\n45,open,MR\n' +
    '30,completed,CT\n30,noshow,CT\n30,open,CT\n20,completed,US',
  referrals:
    'referrerId,referrerName\nr1,Dr. Adams\nr1,Dr. Adams\nr2,Dr. Brooks\nr4,Dr. Diaz',
  referrals_prior:
    'referrerId,referrerName\nr1,Dr. Adams\nr1,Dr. Adams\nr1,Dr. Adams\nr2,Dr. Brooks\nr3,Dr. Chen',
};

// --- supply catalog (UDI/GTIN — restricted contrast + commodity items) ----
const SUPPLY_ITEMS = [
  { gtin: '00380740000011', name: 'Iohexol 350mg/mL 50mL', category: 'contrast', pack_size: 10, unit_cost: 25, par_level: 30, reorder_point: 12, lead_time_days: 5, vendor: 'McKesson', restricted: true },
  { gtin: '00382000000017', name: 'Gadobutrol 1.0 15mL', category: 'contrast', pack_size: 5, unit_cost: 60, par_level: 20, reorder_point: 8, lead_time_days: 7, vendor: 'Bayer', restricted: true },
  { gtin: '10380010000013', name: 'Syringe 60mL Luer-Lok', category: 'other', pack_size: 50, unit_cost: 0.4, par_level: 200, reorder_point: 60, lead_time_days: 3, vendor: 'Cardinal', restricted: false },
  { gtin: '20380020000010', name: 'Nitrile Gloves L (box)', category: 'ppe', pack_size: 10, unit_cost: 8, par_level: 40, reorder_point: 15, lead_time_days: 4, vendor: 'Cardinal', restricted: false },
];

async function main() {
  console.log(`Seeding ${BASE} …`);

  const health = await call('GET', '/health');
  if (!health.ok) {
    console.error(`\n  Cannot reach the server at ${BASE}. Start it first:  cd server && npm run dev\n`);
    process.exit(1);
  }
  log('server', `${health.data.store} store, encryption ${health.data.encryption}`);

  // 1. BI warehouse
  console.log('\nBusiness intelligence:');
  for (const [dataset, csv] of Object.entries(CSV)) {
    const r = await call('POST', '/api/bi/ingest', { dataset, format: 'csv', csv, replace: true });
    log(dataset, r.ok ? `${r.data.ingested} rows` : `failed: ${r.data?.error}`);
  }

  // 2. Living features — install two Tier-1 catalog reports and activate them
  console.log('\nLiving features:');
  for (const key of ['referrer-scorecard', 'denials-by-payer-csv']) {
    const inst = await call('POST', `/api/features/catalog/${key}/install`, {});
    if (!inst.ok) { log(key, `skipped (${inst.data?.error ?? inst.status})`); continue; }
    const id = inst.data.feature.id;
    const appr = await call('POST', `/api/features/${id}/approve`, {});
    log(key, appr.ok ? `installed + active (#${id}, signed)` : `installed, approve failed: ${appr.data?.error}`);
  }

  // 3. Supplies — register items, receive stock, then consume one item below
  //    its reorder point so an auto-proposed (gated) order is waiting.
  console.log('\nSupplies:');
  for (const item of SUPPLY_ITEMS) {
    const reg = await call('POST', '/api/supplies/items', item);
    if (!reg.ok) { log(item.name, `skipped (${reg.data?.error ?? reg.status})`); continue; }
    // receive a starting lot via a UDI scan (expiry/lot ride along)
    const expiry = item.restricted ? '270331' : '281231';
    await call('POST', '/api/supplies/scan', { code: `(01)${item.gtin}(17)${expiry}(10)SEED1`, action: 'receive', qty: item.par_level });
    log(item.name, `stocked ${item.par_level}${item.restricted ? ' (restricted)' : ''}`);
  }
  // drive the first contrast item below reorder → triggers a gated proposal
  const drain = await call('POST', '/api/supplies/scan', { code: '00380740000011', action: 'use', qty: 20 });
  if (drain.ok && drain.data.reorder) {
    log('auto-reorder', `order #${drain.data.reorder.id} proposed for Iohexol (awaits confirmation — restricted)`);
  }

  // 4. A service principal for the MCP surface (token printed once)
  console.log('\nMCP access:');
  const sp = await call('POST', '/api/principals', { name: `local-mcp-${Date.now().toString(36)}`, roles: ['executive', 'admin'] });
  if (sp.ok) {
    log('service principal', sp.data.principal.name);
    console.log(`\n  To drive the app from Claude Code:`);
    console.log(`    VALUERAD_SERVICE_TOKEN=${sp.data.token} \\`);
    console.log(`    claude mcp add valuerad -- node ${process.cwd()}/mcp.js`);
  }

  console.log(`\nDone. Open the dashboard (npm run dev at repo root) — it now has data to show.\n`);
}

main().catch((err) => {
  console.error('seed failed:', err.message);
  process.exit(1);
});
