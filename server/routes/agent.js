/**
 * Agent endpoint — runs the command-center agent on a task.
 *
 * POST /api/agent/run  { task, mode?, context?, data? }
 *
 * Defaults to "recommend" mode (no mutations; proposals only). Requires a
 * privileged role. Returns 503 if no ANTHROPIC_API_KEY is configured, since the
 * agent needs the model.
 */

import { Router } from 'express';
import { runAgent, createClient } from '../agent/runner.js';
import { runAgentDev } from '../agent/runnerDev.js';
import { store } from '../lib/store.js';
import { queue } from '../lib/jobs.js';
import { FhirClient, SchedulingClient } from '../lib/fhir.js';
import { requireRole, ROLES } from '../lib/rbac.js';
import { loadActiveRulePack } from '../lib/features.js';

const router = Router();

router.post('/agent/run', requireRole(ROLES.ADMIN, ROLES.EXECUTIVE, ROLES.SCHEDULER, ROLES.AUTH_SPECIALIST), async (req, res) => {
  const { task, mode = 'recommend', context = {}, data = {} } = req.body ?? {};
  if (!task || typeof task !== 'string') {
    return res.status(400).json({ error: 'task (string) is required' });
  }
  if (!['recommend', 'autonomous'].includes(mode)) {
    return res.status(400).json({ error: "mode must be 'recommend' or 'autonomous'" });
  }

  const client = await createClient();
  if (!client && process.env.NODE_ENV === 'production') {
    return res.status(503).json({ error: 'agent_unavailable', detail: 'ANTHROPIC_API_KEY is not configured.' });
  }

  // If a live SMART session is attached, point the agent's read/write tools at
  // the real EHR (e.g. the Epic sandbox). Otherwise fall back to demo data.
  const sessionId = req.headers['x-valuerad-session'] ?? null;
  let fhir = null;
  let scheduling = data.scheduling ?? { findOpenSlots: async () => data.slots ?? [], bookAppointment: async (a) => a };

  if (sessionId) {
    const ctx = await store.getSessionWithTokens(sessionId);
    if (ctx?.accessToken) {
      fhir = new FhirClient({ baseUrl: ctx.fhirBaseUrl, accessToken: ctx.accessToken });
      scheduling = new SchedulingClient(fhir);
    }
  }

  // Active payer rule packs (Tier-2 living features) feed the auth guardrail.
  const rulePack = await loadActiveRulePack();

  // `data` carries any extra domain context the agent's tools read (waitlist,
  // radiologists, coverage, etc.) until every provider is EHR-backed per tenant.
  const services = {
    store,
    queue,
    sessionId,
    scheduling,
    fhir,
    rulePack,
    ...data,
  };

  try {
    const result = client
      ? await runAgent({ task, client, services, mode, ctx: { rulePack, ...context } })
      // Dev fallback: no API key → Claude Code subscription auth (Agent SDK).
      // Same tools through the same guardrail; refuses live EHR sessions (no BAA).
      : await runAgentDev({ task, services, mode, ctx: { rulePack, ...context } });
    return res.json(result);
  } catch (err) {
    console.error('[agent] run error:', err.message);
    if (!client) {
      return res.status(503).json({
        error: 'agent_unavailable',
        detail: `${err.message} — set ANTHROPIC_API_KEY, or for development run \`claude /login\` with a Claude Pro/Max subscription and leave the key unset.`,
      });
    }
    return res.status(500).json({ error: 'agent_error', detail: err.message });
  }
});

export { router as agentRouter };
