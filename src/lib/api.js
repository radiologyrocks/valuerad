/**
 * Tiny API client for the command-center dashboard.
 *
 * - VITE_API_BASE: backend origin (default same-origin; set to e.g.
 *   http://localhost:3001 in dev, or your tunnel/VPS URL).
 * - VITE_DEV_USER / VITE_DEV_ROLES: dev-only identity headers the RBAC scaffold
 *   reads. Replace with a real IdP-issued session before production.
 */

const API_BASE = import.meta.env.VITE_API_BASE || '';
const DEV_USER = import.meta.env.VITE_DEV_USER || 'demo@valuerad.com';
const DEV_ROLES = import.meta.env.VITE_DEV_ROLES || 'executive,admin,scheduler,auth_specialist';

export async function apiPost(path, body, { session } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    'X-ValueRad-User': DEV_USER,
    'X-ValueRad-Roles': DEV_ROLES,
  };
  if (session) headers['X-ValueRad-Session'] = session;

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch {
    const err = new Error(`Could not reach the backend at ${API_BASE || 'this origin'}. Is the server running?`);
    err.status = 0;
    throw err;
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.detail || data?.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export { API_BASE };
