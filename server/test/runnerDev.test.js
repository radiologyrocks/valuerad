import { test } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.DATABASE_URL;
delete process.env.NODE_ENV;

import { runAgentDev, buildOpsTools, shapeFrom } from '../agent/runnerDev.js';
import { TOOLS } from '../agent/tools.js';
import { AUTH_STATES } from '../domain/priorauth.js';

// Minimal fake of the Agent SDK surface runnerDev uses: `script` lists tool
// calls to drive, exactly as Claude Code would call the registered handlers.
function fakeSdk({ script }) {
  const calls = [];
  return {
    calls,
    tool: (name, description, shape, handler) => ({ name, description, shape, handler }),
    createSdkMcpServer: ({ name, tools }) => ({ name, tools }),
    query({ prompt, options }) {
      calls.push({ prompt, options });
      return (async function* () {
        const byName = Object.fromEntries(options.mcpServers.ops.tools.map((t) => [t.name, t]));
        for (const step of script) await byName[step.tool].handler(step.input);
        yield { type: 'result', subtype: 'success', result: 'Recommended next steps.', total_cost_usd: 0 };
      })();
    },
  };
}

test('shapeFrom converts JSON schemas: types, enums, required vs optional', () => {
  const shape = shapeFrom(TOOLS.send_patient_reminder.input_schema);
  assert.ok(shape.patientId && shape.appointmentId && shape.channel);
  // required parse
  assert.ok(shape.patientId.safeParse('p1').success);
  assert.ok(!shape.patientId.safeParse(undefined).success);
  // optional enum
  assert.ok(shape.channel.safeParse('sms').success);
  assert.ok(shape.channel.safeParse(undefined).success);
  assert.ok(!shape.channel.safeParse('carrier-pigeon').success);
});

test('buildOpsTools wraps every action-plane tool', () => {
  const sdk = { tool: (name, d, s, h) => ({ name, d, s, h }) };
  const tools = buildOpsTools(sdk, { services: {}, mode: 'recommend', ctx: {} }, async () => {});
  assert.equal(tools.length, Object.keys(TOOLS).length);
});

test('recommend mode over the subscription transport: writes are PROPOSED, never executed', async () => {
  const booked = [];
  const services = {
    scheduling: { findOpenSlots: async () => [], bookAppointment: async (a) => { booked.push(a); return a; } },
  };
  const sdk = fakeSdk({
    script: [
      { tool: 'assess_no_show_risk', input: { priorNoShows: 2 } },
      { tool: 'book_appointment', input: { patientId: 'p1', slotId: 's1', modality: 'US', start: '2026-06-15T09:00:00Z' } },
    ],
  });

  const result = await runAgentDev({ task: 'book it', services, mode: 'recommend', sdkImpl: sdk });
  assert.equal(result.transport, 'claude-subscription');
  assert.equal(result.executed.length, 1); // the read tool
  assert.equal(result.proposals.length, 1); // the write, awaiting approval
  assert.equal(result.proposals[0].tool, 'book_appointment');
  assert.equal(booked.length, 0); // nothing actually mutated
});

test('guardrail still blocks unsafe bookings on this transport', async () => {
  const sdk = fakeSdk({
    script: [{ tool: 'book_appointment', input: { patientId: 'p1', slotId: 's1', modality: 'MR', payer: 'Aetna', start: 'x' } }],
  });
  const result = await runAgentDev({
    task: 'book the MRI', services: {}, mode: 'autonomous',
    ctx: { authStatus: AUTH_STATES.PENDING },
    sdkImpl: sdk,
  });
  assert.equal(result.blocked.length, 1);
  assert.equal(result.blocked[0].reason, 'auth_required_not_approved');
  assert.equal(result.executed.length, 0);
});

test('audit rows record the transport', async () => {
  const audits = [];
  const sdk = fakeSdk({ script: [{ tool: 'assess_no_show_risk', input: {} }] });
  await runAgentDev({
    task: 'x',
    services: { store: { audit: async (e) => audits.push(e) }, sessionId: null },
    sdkImpl: sdk,
  });
  assert.equal(audits[0].action, 'agent.executed');
  assert.equal(audits[0].detail.transport, 'claude-subscription');
});

test('refuses a live EHR session — no PHI on a no-BAA transport', async () => {
  await assert.rejects(
    () => runAgentDev({ task: 'x', services: { fhir: {} }, sdkImpl: fakeSdk({ script: [] }) }),
    /live EHR session/
  );
});

test('refuses to run in production', async () => {
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(
      () => runAgentDev({ task: 'x', services: {}, sdkImpl: fakeSdk({ script: [] }) }),
      /development-only/
    );
  } finally {
    delete process.env.NODE_ENV;
  }
});

test('agent world is restricted to the action plane', async () => {
  const sdk = fakeSdk({ script: [] });
  await runAgentDev({ task: 'x', services: {}, sdkImpl: sdk });
  const { options } = sdk.calls[0];
  assert.deepEqual(options.allowedTools, Object.keys(TOOLS).map((n) => `mcp__ops__${n}`));
  assert.ok(options.disallowedTools.includes('Bash'));
});
