import express from 'express';
import { smartRouter } from './routes/smart.js';
import { leadsRouter } from './routes/leads.js';
import { agentRouter } from './routes/agent.js';
import { biRouter } from './routes/bi.js';
import { featuresRouter } from './routes/features.js';
import { migrate, databaseEnabled, closeDb } from './lib/db.js';
import { storeBackend } from './lib/store.js';
import { encryptionEnabled } from './lib/crypto.js';

const app = express();
const PORT = process.env.PORT || 3001;

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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) =>
  res.json({ status: 'ok', store: storeBackend, encryption: encryptionEnabled ? 'on' : 'off' })
);

app.use('/epic', smartRouter);
app.use('/api', leadsRouter);
app.use('/api', agentRouter);
app.use('/api', biRouter);
app.use('/api', featuresRouter);

async function start() {
  try {
    await migrate();
  } catch (err) {
    console.error('[startup] migration failed:', err.message);
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`ValueRad server listening on port ${PORT} (store=${storeBackend}, encryption=${encryptionEnabled ? 'on' : 'off'})`);
  });

  const shutdown = async () => {
    server.close();
    await closeDb();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start();
