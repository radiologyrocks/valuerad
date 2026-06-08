/**
 * Thin client for the ValueRad billing API.
 *
 * Sends the SMART session handle (if the app was launched from Epic) and the
 * current user so the backend can resolve Epic context and attribute addenda.
 * Reads the session handle from the URL (?session=...) set by the SMART
 * callback redirect, and persists it for the life of the tab.
 */

const SESSION_KEY = 'valuerad.session';

function getSessionHandle() {
  const fromUrl = new URLSearchParams(window.location.search).get('session');
  if (fromUrl) {
    try { sessionStorage.setItem(SESSION_KEY, fromUrl); } catch { /* ignore */ }
    return fromUrl;
  }
  try { return sessionStorage.getItem(SESSION_KEY) ?? ''; } catch { return ''; }
}

function headers(extra = {}) {
  const h = { 'Content-Type': 'application/json', ...extra };
  const session = getSessionHandle();
  if (session) h['x-valuerad-session'] = session;
  const user = sessionStorage.getItem('valuerad.user');
  if (user) h['x-valuerad-user'] = user;
  return h;
}

async function request(path, options = {}) {
  const res = await fetch(path, { ...options, headers: headers(options.headers) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.detail || data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const api = {
  listExceptions: (status) =>
    request(`/billing/exceptions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  getException: (id) => request(`/billing/exceptions/${encodeURIComponent(id)}`),
  draftAddendum: (id, body = {}) =>
    request(`/billing/exceptions/${encodeURIComponent(id)}/draft-addendum`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  pushAddendum: (id, text) =>
    request(`/billing/exceptions/${encodeURIComponent(id)}/push-addendum`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  resolve: (id, addendumText) =>
    request(`/billing/exceptions/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ addendumText }),
    }),
};
