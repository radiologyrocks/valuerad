/**
 * Service-principal management — admin-only, every change audited.
 *
 *   GET  /api/principals               list (no token hashes)
 *   POST /api/principals               { name, roles } → token returned ONCE
 *   POST /api/principals/:id/revoke
 *
 * Roles a principal may hold are the standard ROLES; granting `admin` to a
 * machine identity is allowed but flagged in the audit detail.
 */

import { Router } from 'express';
import { requireRole, ROLES } from '../lib/rbac.js';
import { principals, principalsBackend } from '../lib/principals.js';
import { store } from '../lib/store.js';

const router = Router();
const admin = requireRole(ROLES.ADMIN);

const VALID_ROLES = Object.values(ROLES);

router.get('/principals', admin, async (_req, res) => {
  try {
    return res.json({ backend: principalsBackend, principals: await principals.list() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

router.post('/principals', admin, async (req, res) => {
  const { name, roles } = req.body ?? {};
  if (!name || typeof name !== 'string' || !/^[a-z0-9][a-z0-9-_]{1,63}$/.test(name)) {
    return res.status(400).json({ error: 'name must be a short lowercase slug' });
  }
  if (!Array.isArray(roles) || roles.length === 0 || !roles.every((r) => VALID_ROLES.includes(r))) {
    return res.status(400).json({ error: `roles must be a non-empty subset of: ${VALID_ROLES.join(', ')}` });
  }
  try {
    const { principal, token } = await principals.create({ name, roles, createdBy: req.user.id });
    await store.audit({
      actor: req.user.id,
      action: 'principal.created',
      resource: `service_principal/${name}`,
      outcome: 'success',
      detail: { roles, adminGranted: roles.includes(ROLES.ADMIN) },
    });
    // The only time the plaintext token ever leaves the server.
    return res.status(201).json({ principal, token });
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
});

router.post('/principals/:id/revoke', admin, async (req, res) => {
  try {
    const principal = await principals.revoke(req.params.id);
    if (!principal) return res.status(404).json({ error: 'principal not found' });
    await store.audit({
      actor: req.user.id,
      action: 'principal.revoked',
      resource: `service_principal/${principal.name}`,
      outcome: 'success',
    });
    return res.json({ principal });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as principalsRouter };
