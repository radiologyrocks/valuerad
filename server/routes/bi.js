/**
 * Business intelligence endpoint (Stage 4).
 *
 * POST /api/bi/snapshot  { slots?, appointments?, auths?, studies?, claims?, marginByModality? }
 *
 * Computes an executive snapshot over operational data. Inputs are supplied in
 * the request until the data warehouse is wired; the aggregation logic is the
 * real, tested code in domain/bi.js. Executive/admin only.
 */

import { Router } from 'express';
import { executiveSnapshot } from '../domain/bi.js';
import { requireRole, ROLES } from '../lib/rbac.js';

const router = Router();

router.post('/bi/snapshot', requireRole(ROLES.EXECUTIVE, ROLES.ADMIN), (req, res) => {
  try {
    return res.json(executiveSnapshot(req.body ?? {}));
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

export { router as biRouter };
