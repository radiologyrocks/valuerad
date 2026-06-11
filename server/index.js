import express from 'express';
import { smartRouter } from './routes/smart.js';
import { leadsRouter } from './routes/leads.js';
import { agentRouter } from './routes/agent.js';
import { biRouter } from './routes/bi.js';
import { featuresRouter } from './routes/features.js';
import { principalsRouter } from './routes/principals.js';
import { suppliesRouter } from './routes/supplies.js';
import { migrate, databaseEnabled, closeDb } from './lib/db.js';
import { store, storeBackend } from './lib/store.js';
import { encryptionEnabled } from './lib/crypto.js';
import { startWorker } from './lib/jobs.js';
import { buildJobHandlers } from './lib/jobHandlers.js';

const app = express();
const PORT = process.env.PORT || 3001;

// Don't let one bad request or a stray rejection take down a PHI service.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err.message);
});

// Production safety: refuse to start handling PHI without encryption + a real DB.
if (process.env.NODE_ENV === 'production') {
  if (!encryptionEnabled) {
    console.error('FATAL: TOKEN_ENC_KEY is required in production (tokens must be encrypted).');
    process.exit(1);
  }
  if (!databaseEnabled) {
    console.error('FATAL: DATABASE_URL is required in production (no durable system of record).');
    process.exit(1);
  }
}

// Bounded body size — feature definitions and CSV ingests are the large
// inputs; an unbounded body is a trivial memory-exhaustion vector.
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', store: storeBackend, encryption: encryptionEnabled ? 'on' : 'off' })
);

app.use('/epic', smartRouter);
app.use('/api', leadsRouter);
app.use('/api', agentRouter);
app.use('/api', biRouter);
app.use('/api', featuresRouter);
app.use('/api', principalsRouter);
app.use('/api', suppliesRouter);

// Terminal error handler — logs internally, returns a generic message with a
// correlation id. Never leak err.message (DB/internal detail) to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const correlationId = Math.random().toString(36).slice(2, 10);
  console.error(`[error ${correlationId}] ${req.method} ${req.path}:`, err.message);
  if (res.headersSent) return;
  res.status(err.status || 500).json({ error: 'internal_error', correlationId });
});

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('[startup] migration failed:', err.message);
    process.exit(1);
  }

  // Start the background worker so enqueued work (prior-auth, reminders,
  // supply-order placement, human escalation) actually runs instead of
  // accumulating in the jobs table.
  const stopWorker = startWorker(buildJobHandlers({ store }));

  const server = app.listen(PORT, () => {
    console.log(`ValueRad server listening on port ${PORT} (store=${storeBackend}, encryption=${encryptionEnabled ? 'on' : 'off'})`);
  });

  const shutdown = async () => {
    stopWorker();
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
