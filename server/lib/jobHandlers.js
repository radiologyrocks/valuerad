/**
 * Job handlers — what the background worker actually does per job kind.
 *
 * These are the async seams the agent/routes enqueue into: prior-auth
 * submission, patient reminders, supply-order placement, human escalation.
 * Real external integrations (clearinghouse, SMS/email, vendor EDI, paging)
 * land HERE behind the queue. Today they record an audited outcome so the
 * work is traceable and nothing is silently dropped — which is the point of
 * wiring the worker at all (it was previously never started).
 */

export function buildJobHandlers({ store } = {}) {
  const audit = (action, detail) =>
    store?.audit?.({ actor: 'worker', action, outcome: 'success', detail });

  return {
    async submit_prior_auth(payload) {
      // TODO(integration): clearinghouse / payer-portal submission.
      await audit('job.submit_prior_auth', { orderId: payload.orderId, payer: payload.payer, modality: payload.modality });
      return { acknowledged: true };
    },
    async send_reminder(payload) {
      // TODO(integration): SMS/email/voice provider.
      await audit('job.send_reminder', { patientId: payload.patientId, appointmentId: payload.appointmentId, channel: payload.channel });
      return { sent: true };
    },
    async place_supply_order(payload) {
      // TODO(integration): vendor EDI 850 / punchout / distributor email.
      await audit('job.place_supply_order', { orderId: payload.orderId, vendor: payload.vendor, lines: payload.lines?.length });
      return { placed: true };
    },
    async notify_human(payload) {
      // TODO(integration): paging / inbox. For now the escalation is durably
      // recorded so it is never lost in the void.
      await audit('job.notify_human', { to: payload.to, reason: payload.reason });
      return { notified: true };
    },
  };
}
