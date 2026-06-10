/**
 * Role-based access control scaffold (Stage 0).
 *
 * SMART authenticates the *clinician via Epic*. This layer governs *ValueRad's
 * own users* — schedulers, auth specialists, radiologists, admins, executives —
 * and, later, the agent itself (role: 'agent'), so every autonomous action is
 * attributable.
 *
 * NOTE: this is the authorization seam, not an identity provider. Wiring a real
 * IdP (and verifying a signed session/JWT) is a Stage 0 follow-up. Until then,
 * `currentUser` is resolved from a trusted header for local development only.
 */

export const ROLES = Object.freeze({
  SCHEDULER: 'scheduler',
  AUTH_SPECIALIST: 'auth_specialist',
  RADIOLOGIST: 'radiologist',
  ADMIN: 'admin',
  EXECUTIVE: 'executive',
  AGENT: 'agent',
});

/**
 * Resolve the acting user. DEV ONLY: reads X-ValueRad-User / X-ValueRad-Roles.
 * Replace with verified IdP-backed sessions before production.
 */
export function currentUser(req) {
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
  return (req, res, next) => {
    const user = currentUser(req);
    if (!user) return res.status(401).json({ error: 'authentication required' });
    if (!user.roles.some((r) => allowed.includes(r))) {
      return res.status(403).json({ error: 'insufficient role' });
    }
    req.user = user;
    next();
  };
}
