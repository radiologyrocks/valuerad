/**
 * Business intelligence endpoints (Stage 4).
 *
 * Two ingestion paths, one metric engine:
 *   - CSV / JSON extracts  → POST /api/bi/ingest      (works today, no integrations)
 *   - Durable warehouse    → query datasets by tag, then compute
 *
 *   POST /api/bi/ingest    { dataset, format:'csv'|'json', csv?|rows?, replace? }
 *   POST /api/bi/snapshot  { ...inline datasets }              (back-compat)
 *   POST /api/bi/scorecard { source:'warehouse' } | { ...inline datasets }
 *   POST /api/bi/report    { source:'warehouse' } | { ...inline datasets }
 *   GET  /api/bi/warehouse  → row counts per dataset
 *
 * Executive / admin only.
 */

import { Router } from 'express';
import { executiveSnapshot, scorecard, ceoReport, DEFAULT_TARGETS } from '../domain/bi.js';
import { parseCsv } from '../lib/csv.js';
import { warehouse, warehouseBackend, loadDatasets, DATASETS } from '../lib/warehouse.js';
import { requireRole, ROLES } from '../lib/rbac.js';
import { activeByKey } from '../lib/features.js';
import { applyMapper } from '../domain/dsl.js';

const router = Router();
const exec = requireRole(ROLES.EXECUTIVE, ROLES.ADMIN);

router.post('/bi/ingest', exec, async (req, res) => {
  const { dataset, format = 'json', csv, rows, source, replace = false, mapper } = req.body ?? {};
  if (!DATASETS.includes(dataset)) {
    return res.status(400).json({ error: `dataset must be one of: ${DATASETS.join(', ')}` });
  }
  let records;
  try {
    records = format === 'csv' ? parseCsv(csv ?? '') : (Array.isArray(rows) ? rows : []);
  } catch (err) {
    return res.status(400).json({ error: `parse failed: ${err.message}` });
  }

  // An ACTIVE ingest_mapper living feature can translate the source's column
  // names/types into the dataset's fields before storage.
  if (mapper) {
    const feature = await activeByKey(mapper);
    if (!feature || feature.kind !== 'ingest_mapper') {
      return res.status(422).json({ error: 'mapper must name an active ingest_mapper feature' });
    }
    if (feature.definition.dataset !== dataset) {
      return res.status(422).json({ error: `mapper "${mapper}" targets dataset "${feature.definition.dataset}", not "${dataset}"` });
    }
    records = applyMapper(feature.definition, records);
  }
  if (records.length === 0) return res.status(400).json({ error: 'no rows to ingest' });

  try {
    const count = await warehouse.ingest(dataset, records, { source: source ?? format, replace });
    return res.status(201).json({ ingested: count, dataset, backend: warehouseBackend });
  } catch (err) {
    console.error('[bi] ingest error:', err.message);
    return res.status(500).json({ error: 'ingest_failed', detail: err.message });
  }
});

router.get('/bi/warehouse', exec, async (_req, res) => {
  try {
    return res.json({ backend: warehouseBackend, counts: await warehouse.counts() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// Resolve datasets either from the request body (inline) or the warehouse.
async function resolveDatasets(body = {}) {
  if (body.source === 'warehouse') {
    const ds = await loadDatasets();
    return { ...ds, marginByModality: body.marginByModality ?? {}, auths: body.auths ?? [] };
  }
  return body;
}

router.post('/bi/snapshot', exec, async (req, res) => {
  try {
    return res.json(executiveSnapshot(await resolveDatasets(req.body ?? {})));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/bi/scorecard', exec, async (req, res) => {
  try {
    const datasets = await resolveDatasets(req.body ?? {});
    const targets = req.body?.targets ?? DEFAULT_TARGETS;
    return res.json(scorecard(datasets, targets));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/bi/report', exec, async (req, res) => {
  try {
    const datasets = await resolveDatasets(req.body ?? {});
    const targets = req.body?.targets ?? DEFAULT_TARGETS;
    return res.json(ceoReport(datasets, targets));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as biRouter };
