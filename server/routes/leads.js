/**
 * Storefront lead capture.
 *
 * POST /api/leads  { name, email, organization, message? }
 *
 * The landing page form posts here (configured via VITE_LEADS_ENDPOINT).
 * Stage 0: persisted to the `leads` table (or in-memory in dev).
 */

import { Router } from 'express';
import { store } from '../lib/store.js';

const router = Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/leads', async (req, res) => {
  const { name, email, organization, message } = req.body ?? {};

  if (!name || !email || !organization) {
    return res.status(400).json({ error: 'name, email and organization are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email is required.' });
  }

  try {
    const id = await store.createLead({
      name: String(name).slice(0, 200),
      email: String(email).slice(0, 200),
      organization: String(organization).slice(0, 200),
      message: message ? String(message).slice(0, 2000) : null,
    });
    return res.status(201).json({ ok: true, id });
  } catch (err) {
    console.error('[leads] store error:', err.message);
    return res.status(500).json({ error: 'Could not save your request. Please try again.' });
  }
});

export { router as leadsRouter };
