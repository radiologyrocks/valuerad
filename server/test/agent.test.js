import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;

import { evaluate, shouldExecute } from '../agent/policy.js';
import { TOOLS, toolSchemas } from '../agent/tools.js';
import { AUTH_STATES } from '../domain/priorauth.js';
import { runAgent } from '../agent/runner.js';

// ---- tool registry / schemas ----
test('toolSchemas exposes name/description/input_schema for every tool', () => {
  const schemas = toolSchemas();
  assert.equal(schemas.length, Object.keys(TOOLS).length);
  for (const s of schemas) {
    assert.ok(s.name && s.description && s.input_schema);
  }
});

// ---- guardrail plane ----
test('read tools always allowed; never need approval', () => {
  const d = evaluate('check_eligibility', { patientId: 'p', modality: 'CT' }, {});
  assert.deepEqual(d, { allow: true, requiresHumanApproval: false, reason: 'read_only' });
});

test('book_appointment blocked when high-cost auth not approved', () => {
  const d = evaluate('book_appointment', { modality: 'MR', payer: 'Aetna' }, { authStatus: AUTH_STATES.PENDING });
  assert.equal(d.allow, false);
  assert.equal(d.reason, 'auth_required_not_approved');
});

test('book_appointment allowed when auth approved; high value needs human approval', () => {
  const d = evaluate('book_appointment', { modality: 'MR', payer: 'Aetna' }, { authStatus: AUTH_STATES.APPROVED });
  assert.equal(d.allow, true);
});

test('low-cost mutation does not require human approval; high-cost does', () => {
  const reminder = evaluate('send_patient_reminder', { patientId: 'p', appointmentId: 'a' }, {});
  assert.equal(reminder.requiresHumanApproval, false);

  const auth = evaluate('submit_prior_auth', { orderId: 'o', modality: 'MR', payer: 'Aetna' }, {});
  assert.equal(auth.requiresHumanApproval, true); // MR is high-value
});

test('escalate_to_human is never blocked', () => {
  const d = evaluate('escalate_to_human', { reason: 'x' }, {});
  assert.equal(d.allow, true);
});

test('shouldExecute: recommend mode never mutates; autonomous executes only un-flagged', () => {
  assert.equal(shouldExecute({ allow: true, requiresHumanApproval: false }, 'recommend'), false);
  assert.equal(shouldExecute({ allow: true, requiresHumanApproval: false }, 'autonomous'), true);
  assert.equal(shouldExecute({ allow: true, requiresHumanApproval: true }, 'autonomous'), false);
  assert.equal(shouldExecute({ allow: false }, 'autonomous'), false);
});

// ---- orchestration plane with an injected fake Claude client ----
function fakeClient(script) {
  let i = 0;
  return {
    messages: {
      async create() {
        return script[i++];
      },
    },
  };
}

test('runAgent executes a read tool then summarizes', async () => {
  const audits = [];
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'assess_no_show_risk', input: { priorNoShows: 3, confirmedReminder: false } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'High risk; recommend reminders.' }] },
  ]);

  const result = await runAgent({
    task: 'Assess no-show risk for this patient.',
    client,
    services: { store: { audit: async (e) => audits.push(e) } },
    mode: 'recommend',
  });

  assert.match(result.summary, /High risk/);
  assert.equal(result.executed.length, 1);
  assert.equal(result.executed[0].tool, 'assess_no_show_risk');
  assert.equal(audits.length, 1);
});

test('runAgent in recommend mode proposes (does not execute) a write tool', async () => {
  const booked = [];
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'send_patient_reminder', input: { patientId: 'p1', appointmentId: 'a1' } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Proposed a reminder.' }] },
  ]);

  const result = await runAgent({
    task: 'Remind the patient.',
    client,
    services: { queue: { enqueue: async () => booked.push('x') } },
    mode: 'recommend',
  });

  assert.equal(result.proposals.length, 1);
  assert.equal(result.executed.length, 0);
  assert.equal(booked.length, 0, 'recommend mode must not mutate');
});

test('runAgent blocks an unsafe booking and records it', async () => {
  const client = fakeClient([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 't1', name: 'book_appointment', input: { patientId: 'p', slotId: 's', modality: 'MR', start: '2026-07-01T09:00:00Z' } },
      ],
    },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Could not book; auth missing.' }] },
  ]);

  const result = await runAgent({
    task: 'Book the MRI.',
    client,
    services: {},
    mode: 'autonomous',
    ctx: { authStatus: AUTH_STATES.PENDING },
  });

  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].reason, 'auth_required_not_approved');
  assert.equal(result.executed.length, 0);
});

test('runAgent throws without a client', async () => {
  await assert.rejects(() => runAgent({ task: 'x', client: null }), /not configured/);
});
