/**
 * The ACTION PLANE — the agent's hands.
 *
 * Each capability is a discrete, typed, audited tool. The LLM chooses and fills
 * tools; it never touches the EHR or the database directly. Tools are split into
 * `read` (parallel-safe, observe) and `write` (mutating, gated by policy).
 *
 * Handlers receive ({ input, services }) where `services` carries the scheduling
 * client, FHIR client, store, and any domain data — injected so this is testable
 * without a live EHR.
 */

import { noShowRisk, rankSlots, bestBackfill } from '../domain/scheduling.js';
import { evaluateEligibility } from '../domain/eligibility.js';
import { authRequired, AUTH_STATES, safeToPerform } from '../domain/priorauth.js';
import { routeStudy } from '../domain/worklist.js';
import { stockStatus, proposeReorder, evaluateSupplyOrder } from '../domain/supply.js';

export const TOOLS = {
  find_open_slots: {
    kind: 'read',
    description:
      'Find and rank open scanner slots for a study. Call this when scheduling or rescheduling a patient. Ranks for scanner utilization (fills idle capacity first), not just any availability.',
    input_schema: {
      type: 'object',
      properties: {
        modality: { type: 'string', description: 'e.g. MR, CT, US' },
        durationMin: { type: 'integer', description: 'study duration in minutes' },
        earliest: { type: 'string', description: 'ISO date-time lower bound' },
        latest: { type: 'string', description: 'ISO date-time upper bound' },
      },
      required: ['modality'],
    },
    async handler({ input, services }) {
      const slots = await services.scheduling.findOpenSlots({
        scheduleId: input.scheduleId,
        start: input.earliest,
        end: input.latest,
      });
      const list = Array.isArray(slots?.entry) ? slots.entry.map((e) => e.resource) : slots ?? [];
      return { ranked: rankSlots(list, input, services.bookedSlots ?? []) };
    },
  },

  check_eligibility: {
    kind: 'read',
    description:
      'Verify insurance coverage/benefits for a high-cost study BEFORE booking. Call this for any MR/CT/PET/NM order so the practice never scans something it cannot get paid for.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: { type: 'string' },
        modality: { type: 'string' },
      },
      required: ['patientId', 'modality'],
    },
    async handler({ input, services }) {
      const coverageBundle = services.fhir ? await services.fhir.coverage(input.patientId) : null;
      const coverage = coverageBundle?.entry?.[0]?.resource ?? services.coverage ?? null;
      return evaluateEligibility(coverage, { modality: input.modality });
    },
  },

  assess_no_show_risk: {
    kind: 'read',
    description:
      'Score a patient/appointment for no-show risk with an explainable breakdown. Use to decide reminders, overbooking, or waitlist priority.',
    input_schema: {
      type: 'object',
      properties: {
        priorNoShows: { type: 'integer' },
        leadTimeDays: { type: 'integer' },
        priorReschedules: { type: 'integer' },
        confirmedReminder: { type: 'boolean' },
        slotHour: { type: 'integer' },
      },
    },
    async handler({ input }) {
      return noShowRisk(input);
    },
  },

  check_auth_status: {
    kind: 'read',
    description: 'Check the prior-authorization status for an order. Call before booking or performing any study that requires auth.',
    input_schema: {
      type: 'object',
      properties: { orderId: { type: 'string' } },
      required: ['orderId'],
    },
    async handler({ input, services }) {
      const auth = services.auths?.[input.orderId] ?? null;
      return { orderId: input.orderId, status: auth?.status ?? 'none', history: auth?.history ?? [] };
    },
  },

  find_waitlist_backfill: {
    kind: 'read',
    description: 'When a slot opens (cancel/no-show), find the best waitlisted patient to fill it. Maximizes utilization recovery.',
    input_schema: {
      type: 'object',
      properties: {
        start: { type: 'string' },
        end: { type: 'string' },
        modality: { type: 'string' },
      },
      required: ['start', 'end'],
    },
    async handler({ input, services }) {
      return { candidate: bestBackfill(input, services.waitlist ?? []) };
    },
  },

  route_worklist_study: {
    kind: 'read',
    description: 'Route a completed study to the best available radiologist by subspecialty match and current load. Use to balance the reading worklist.',
    input_schema: {
      type: 'object',
      properties: {
        modality: { type: 'string' },
        subspecialty: { type: 'string' },
        urgency: { type: 'string', enum: ['stat', 'routine'] },
      },
      required: ['modality'],
    },
    async handler({ input, services }) {
      return { assignment: routeStudy(input, services.radiologists ?? []) };
    },
  },

  check_supply_levels: {
    kind: 'read',
    description:
      'Check supply inventory: items at/below their reorder point and lots expiring soon. Call when asked about supplies, stock, contrast, or before proposing a supply order.',
    input_schema: { type: 'object', properties: {} },
    async handler({ services }) {
      if (!services.supplies) return { items: [], note: 'supply store not attached' };
      const items = await services.supplies.listItems();
      const statuses = [];
      for (const item of items) {
        const [lots, events] = await Promise.all([
          services.supplies.lotsForItem(item.id),
          services.supplies.eventsForItem(item.id),
        ]);
        statuses.push(stockStatus(item, lots, events));
      }
      return {
        belowReorder: statuses.filter((s) => s.belowReorder),
        expiring: statuses.filter((s) => s.expiring.length > 0).map((s) => ({ name: s.name, lots: s.expiring })),
        totalItems: statuses.length,
      };
    },
  },

  // ---- write tools (mutating; gated by policy) ----

  propose_supply_order: {
    kind: 'write',
    description:
      'Create a PROPOSED supply order for an item that is at/below its reorder point. The order still passes policy gates and (for restricted or high-dollar items) human confirmation before any money moves.',
    input_schema: {
      type: 'object',
      properties: {
        gtin: { type: 'string', description: 'the item GTIN' },
        qty: { type: 'integer', description: 'override quantity; defaults to the computed reorder amount' },
      },
      required: ['gtin'],
    },
    async handler({ input, services }) {
      if (!services.supplies) return { proposed: false, reason: 'supply store not attached' };
      const item = await services.supplies.getItemByGtin(input.gtin);
      if (!item) return { proposed: false, reason: 'unknown_item' };
      const [lots, events, openIds] = await Promise.all([
        services.supplies.lotsForItem(item.id),
        services.supplies.eventsForItem(item.id),
        services.supplies.openOrderItemIds(),
      ]);
      let line = proposeReorder(item, lots, events);
      if (input.qty) {
        const unitCost = Number(item.unit_cost) || 0;
        line = { itemId: item.id, gtin: item.gtin, name: item.name, qty: input.qty, unitCost, lineTotal: Number((input.qty * unitCost).toFixed(2)), restricted: Boolean(item.restricted) };
      }
      if (!line) return { proposed: false, reason: 'above_reorder_point' };
      const draft = { lines: [line], total_cost: line.lineTotal };
      const decision = evaluateSupplyOrder(draft, { openOrderItemIds: openIds });
      if (!decision.allow) return { proposed: false, blocked: true, reason: decision.reason };
      const order = await services.supplies.createOrder({
        ...draft,
        vendor: item.vendor,
        created_by: 'agent',
        history: [{ from: null, to: 'proposed', at: new Date().toISOString(), by: 'agent', gate: decision.reason }],
      });
      return { proposed: true, orderId: order.id, total: line.lineTotal, requiresHumanApproval: decision.requiresHumanApproval, gate: decision.reason };
    },
  },

  book_appointment: {
    kind: 'write',
    description:
      'Book a scanner appointment. Only call after eligibility is verified and, for studies that require it, prior auth is approved. The platform blocks unsafe bookings.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: { type: 'string' },
        slotId: { type: 'string' },
        modality: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
      },
      required: ['patientId', 'slotId', 'modality', 'start'],
    },
    async handler({ input, services }) {
      const appointment = {
        resourceType: 'Appointment',
        status: 'booked',
        slot: [{ reference: `Slot/${input.slotId}` }],
        participant: [{ actor: { reference: `Patient/${input.patientId}` }, status: 'accepted' }],
        start: input.start,
        end: input.end,
      };
      const result = await services.scheduling.bookAppointment(appointment);
      return { booked: true, appointment: result ?? appointment };
    },
  },

  submit_prior_auth: {
    kind: 'write',
    description: 'Submit a prior-authorization request to the payer for a high-cost study. Enqueues an async payer workflow.',
    input_schema: {
      type: 'object',
      properties: {
        orderId: { type: 'string' },
        patientId: { type: 'string' },
        modality: { type: 'string' },
        payer: { type: 'string' },
      },
      required: ['orderId', 'modality', 'payer'],
    },
    async handler({ input, services }) {
      const required = authRequired({ modality: input.modality }, { name: input.payer }, services.rulePack ?? null);
      if (!required.required) return { submitted: false, reason: required.reason };
      const jobId = services.queue ? await services.queue.enqueue('submit_prior_auth', input) : null;
      return { submitted: true, status: AUTH_STATES.SUBMITTED, jobId };
    },
  },

  send_patient_reminder: {
    kind: 'write',
    description: 'Send a multi-channel appointment reminder to a patient. Low-risk; reduces no-shows.',
    input_schema: {
      type: 'object',
      properties: {
        patientId: { type: 'string' },
        channel: { type: 'string', enum: ['sms', 'email', 'voice'] },
        appointmentId: { type: 'string' },
      },
      required: ['patientId', 'appointmentId'],
    },
    async handler({ input, services }) {
      const jobId = services.queue ? await services.queue.enqueue('send_reminder', input) : null;
      return { queued: true, jobId };
    },
  },

  escalate_to_human: {
    kind: 'write',
    description: 'Hand a decision to a human (scheduler, auth specialist, or radiologist). Always available. Use whenever a guardrail blocks an action or the situation is ambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        role: { type: 'string', enum: ['scheduler', 'auth_specialist', 'radiologist', 'admin'] },
        context: { type: 'object' },
      },
      required: ['reason'],
    },
    async handler({ input }) {
      return { escalated: true, to: input.role ?? 'admin', reason: input.reason };
    },
  },
};

/** Build the Anthropic tools array (name + description + input_schema). */
export function toolSchemas() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

export { safeToPerform, authRequired, evaluateEligibility };
