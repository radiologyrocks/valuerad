/**
 * Practice model + reimbursement endpoints.
 *
 *   GET  /api/practice/config              → current config (stored or CT default)
 *   PUT  /api/practice/config   { config } → persist a customized config
 *   POST /api/practice/model    { volume? } → build the hypergraph + P&L
 *   POST /api/practice/scenario { volume?, levers } → projected income vs baseline
 *   POST /api/practice/estimate { code, payer, component?, pos?, rank? }
 *                                          → real-time expected $ + wRVU for one study
 *
 * Config is per-practice and fully customizable; CT/Medicare defaults ship.
 */

import { Router } from 'express';
import { defaultPracticeConfig, buildModel, computePnL, projectScenario, sampleVolume } from '../domain/practice.js';
import { estimatePayment } from '../domain/reimbursement.js';
import { warehouse } from '../lib/warehouse.js';
import { requireRole, ROLES } from '../lib/rbac.js';

const router = Router();
const exec = requireRole(ROLES.EXECUTIVE, ROLES.ADMIN);
const CONFIG_DATASET = 'practice_config';

async function getConfig() {
  const rows = await warehouse.query(CONFIG_DATASET);
  return rows[0] ?? defaultPracticeConfig('CT');
}

router.get('/practice/config', exec, async (_req, res) => {
  try { return res.json(await getConfig()); }
  catch (err) { return res.status(500).json({ error: err.message }); }
});

router.put('/practice/config', exec, async (req, res) => {
  const config = req.body?.config;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: 'config object required' });
  try {
    await warehouse.ingest(CONFIG_DATASET, [config], { replace: true });
    return res.json({ ok: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/practice/model', exec, async (req, res) => {
  try {
    const config = req.body?.config ?? (await getConfig());
    const volume = req.body?.volume ?? sampleVolume(config);
    const model = buildModel(config, volume);
    return res.json({
      pnl: computePnL(model),
      graph: { nodes: model.graph.nodes.size, edges: model.graph.edges.size },
    });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

router.post('/practice/scenario', exec, async (req, res) => {
  try {
    const config = req.body?.config ?? (await getConfig());
    const volume = req.body?.volume ?? sampleVolume(config);
    const levers = Array.isArray(req.body?.levers) ? req.body.levers : [];
    const model = buildModel(config, volume);
    return res.json(projectScenario(model, levers));
  } catch (err) { return res.status(400).json({ error: err.message }); }
});

router.post('/practice/estimate', requireRole(ROLES.EXECUTIVE, ROLES.ADMIN, ROLES.RADIOLOGIST, ROLES.SCHEDULER, ROLES.AUTH_SPECIALIST), async (req, res) => {
  const { code, payer, component, pos, rank } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'code required' });
  try {
    const config = req.body?.config ?? (await getConfig());
    return res.json(estimatePayment({ code }, { config, payer, component, pos, rank }));
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

export { router as practiceRouter };
