/**
 * Role-based access control (Stage 0 + agent principals).
 *
 * SMART authenticates the *clinician via Epic*. This layer governs *ValueRad's
 * own actors* — staff (schedulers, auth specialists, radiologists, admins,
 * executives) and, as first-class identities, service principals: agents and
 * integrations with their own scoped credentials (lib/principals.js), so
 * every autonomous action is attributable to a specific principal.
 *
 * Resolution order:
 *   1. `Authorization: Bearer vrad_sp_...` → service principal (all envs).
 *   2. Dev headers X-ValueRad-User / X-ValueRad-Roles — DEVELOPMENT ONLY;
 *      disabled in production, where humans come from a real IdP (Stage-0
 *      follow-up) and machines come from principals.
 */

import { principals, TOKEN_PREFIX } from './principals.js';

export const ROLES = Object.freeze({
  SCHEDULER: 'scheduler',
  AUTH_SPECIALIST: 'auth_specialist',
  RADIOLOGIST: 'radiologist',
  ADMIN: 'admin',
  EXECUTIVE: 'executive',
  AGENT: 'agent',
});

/** Resolve the acting user/principal. Async: principal lookup hits the store. */
export async function currentUser(req) {
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!token.startsWith(TOKEN_PREFIX)) return null;
    const principal = await principals.findByToken(token);
    if (!principal) return null;
    return { id: `svc:${principal.name}`, roles: principal.roles ?? [], principal: true };
  }

  if (process.env.NODE_ENV === 'production') return null; // dev headers never authenticate in prod

  const id = req.headers['x-valuerad-user'];
  if (!id) return null;
  const roles = String(req.headers['x-valuerad-roles'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  return { id, roles };
}

/** Express middleware: require at least one of the given roles. Default-deny. */
export function requireRole(...allowed) {
  return async (req, res, next) => {
    let user;
    try {
      user = await currentUser(req);
    } catch (err) {
      return res.status(500).json({ error: 'auth_error', detail: err.message });
    }
    if (!user) return res.status(401).json({ error: 'authentication required' });
    if (!user.roles.some((r) => allowed.includes(r))) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    req.user = user;
    next();
  };
}

/**
 * Run after requireRole on endpoints where the "requires a HUMAN" invariant
 * must hold (feature activation, supply-order confirmation). A service
 * principal — even one granted admin/executive — is a machine identity and
 * cannot satisfy a human-approval gate. This is what makes "the agent proposes,
 * a human disposes" real rather than an RBAC role a token happens to hold.
 */
export function requireHuman(req, res, next) {
  if (req.user?.principal) {
    return res.status(403).json({
      error: 'human_approval_required',
      detail: 'This action requires a human approver; service-principal identities cannot approve.',
    });
  }
  next();
}
