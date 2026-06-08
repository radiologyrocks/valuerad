import express from 'express';
import { smartRouter } from './routes/smart.js';
import { billingRouter } from './routes/billing.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/epic', smartRouter);
app.use('/billing', billingRouter);

app.listen(PORT, () => {
  console.log(`ValueRad SMART server listening on port ${PORT}`);
});
