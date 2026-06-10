import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL; // memory queue

const { queue, runOnce } = await import('../lib/jobs.js');

test('enqueue + runOnce dispatches to the right handler', async () => {
  const seen = [];
  await queue.enqueue('send_reminder', { patientId: 'p1' });
  const ran = await runOnce({ send_reminder: async (payload) => seen.push(payload.patientId) });
  assert.equal(ran, true);
  assert.deepEqual(seen, ['p1']);
});

test('runOnce returns false when queue is empty', async () => {
  const ran = await runOnce({});
  assert.equal(ran, false);
});

test('handler failure schedules a retry (job re-queued)', async () => {
  await queue.enqueue('flaky', {});
  let calls = 0;
  await runOnce({ flaky: async () => { calls++; throw new Error('boom'); } });
  assert.equal(calls, 1);
  // It should be retryable: a later claim (after backoff) would pick it up again.
  // We assert the job is not in a terminal 'failed' state on first attempt.
  const job = queue.jobs.find((j) => j.kind === 'flaky');
  assert.equal(job.status, 'queued');
  assert.ok(job.last_error.includes('boom'));
});
