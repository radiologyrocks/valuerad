/**
 * The GUARDRAIL PLANE — the agent's conscience.
 *
 * Sits BETWEEN the model and the action plane. The model proposes; policy
 * disposes. Hard rules here keep "the agent runs it better than the CEO" safe:
 * judgment is bounded, every mutation is attributable and reversible, and the
 * highest-dollar mistake (scanning without auth) is structurally impossible.
 *
 * Pure: returns a decision. The runner enforces it.
 */

import { TOOLS } from './tools.js';
import { authRequired, safeToPerform, AUTH_STATES } from '../domain/priorauth.js';

// Dollar threshold above which a mutating action always needs human sign-off.
const HUMAN_APPROVAL_DOLLARS = 500;

// Rough cost model for "is this an expensive action" (extend from contract data).
const MODALITY_COST = { MR: 1200, MRI: 1200, CT: 800, PET: 3000, NM: 1500, US: 250, XR: 80 };

/**
 * @param {string} toolName
 * @param {object} input
 * @param {object} ctx - { mode: 'recommend'|'autonomous', eligibility?, authStatus?,
 *   rulePack? (active per-contract auth rules — an activated living feature) }
 * @returns {{ allow: boolean, requiresHumanApproval: boolean, reason: string }}
 */
export function evaluate(toolName, input = {}, ctx = {}) {
  const tool = TOOLS[toolName];
  if (!tool) return { allow: false, requiresHumanApproval: false, reason: 'unknown_tool' };

  // Read tools are always safe — they only observe.
  if (tool.kind === 'read') {
    return { allow: true, requiresHumanApproval: false, reason: 'read_only' };
  }

  // escalate_to_human is the safety valve — never blocked.
  if (toolName === 'escalate_to_human') {
    return { allow: true, requiresHumanApproval: false, reason: 'safety_valve' };
  }

  const cost = MODALITY_COST[String(input.modality ?? '').toUpperCase()] ?? 0;

  // --- The single most important rule: nothing high-cost scans without a valid auth. ---
  if (toolName === 'book_appointment') {
    const req = authRequired({ modality: input.modality }, { name: input.payer }, ctx.rulePack ?? null);
    const ok = safeToPerform({ authRequiredResult: req, authStatus: ctx.authStatus });
    if (!ok) {
      return { allow: false, requiresHumanApproval: false, reason: 'auth_required_not_approved' };
    }
    // Must have verified, eligible coverage for a high-cost study before booking.
    if (cost >= HUMAN_APPROVAL_DOLLARS && ctx.eligibility && ctx.eligibility.eligible === false) {
      return { allow: false, requiresHumanApproval: true, reason: 'coverage_not_verified' };
    }
  }

  // Reminders are low-risk; auto-allow.
  if (toolName === 'send_patient_reminder') {
    return { allow: true, requiresHumanApproval: false, reason: 'low_risk' };
  }

  // Submitting auth protects revenue — allow, but it's a mutation, so gate by mode.
  // High-dollar mutations always require human approval, regardless of mode.
  const requiresHumanApproval = cost >= HUMAN_APPROVAL_DOLLARS;
  return {
    allow: true,
    requiresHumanApproval,
    reason: requiresHumanApproval ? 'high_value_mutation' : 'mutation',
  };
}

/**
 * Decide whether the runner should actually EXECUTE a write tool now.
 * In recommend mode, no mutation executes — it's proposed for human approval.
 * In autonomous mode, a mutation executes only if allowed AND not flagged for
 * human approval.
 */
export function shouldExecute(decision, mode) {
  if (!decision.allow) return false;
  if (mode === 'recommend') return false; // recommend mode never mutates
  return !decision.requiresHumanApproval;
}

export { AUTH_STATES };
