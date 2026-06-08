/**
 * LLM addendum drafting (Claude).
 *
 * Given a billing exception (what MBMS says is wrong) and the existing signed
 * report text (from PowerScribe), draft an addendum that reconciles the report
 * with the charge — in the radiologist's voice, grounded strictly in what was
 * dictated. The output is always a DRAFT for human review and signature; this
 * module never fabricates clinical findings.
 *
 * Uses the official Anthropic SDK (@anthropic-ai/sdk) with Claude Opus 4.8 and
 * adaptive thinking. The SDK is imported lazily so the server still boots (and
 * the rest of the billing workflow still runs against mock sources) when the
 * dependency or ANTHROPIC_API_KEY is absent — the route surfaces a clear error.
 */

const MODEL = process.env.ADDENDUM_MODEL ?? 'claude-opus-4-8';

const SYSTEM_PROMPT = `You are a radiology documentation assistant that drafts report ADDENDA for a \
board-certified radiologist to review and sign. Addenda are needed when a billing company flags a \
mismatch between the charge/CPT and what the signed report documents.

Hard rules:
- Draft only. A radiologist always reviews, edits, and signs. Never imply the addendum is final.
- Ground every statement strictly in the provided report text and the exception details. Do NOT \
invent clinical findings, contrast administration, laterality, phases, or views that are not \
supported by the report.
- If the report does not contain the information needed to resolve the mismatch (e.g. it is \
genuinely ambiguous whether contrast was administered), DO NOT guess. Instead set needs_review to \
true, write a reviewReason explaining exactly what the radiologist must confirm, and make the \
addendum a clarification request rather than an assertion.
- Match standard addendum style: begin with "ADDENDUM:" and write in concise, professional \
radiology prose. Reference the specific element being clarified (technique, contrast, laterality, \
views, etc.). Keep it to the minimum needed to resolve the billing exception.
- Never include PHI beyond what is already in the report. Do not add a signature line or date — \
PowerScribe and the signing radiologist handle that.`;

function buildUserPrompt({ exception, reportText, radiologistName }) {
  return `A billing exception was received from the billing company (MBMS).

EXCEPTION
- Exception #: ${exception.exceptionNumber || exception.id}
- Category: ${exception.category}
- Accession: ${exception.accessionNumber}
- Exam: ${exception.studyDescription} (${exception.modality})
- Billed CPT: ${exception.cptCode}
- Payer: ${exception.payer}
- Reason flagged: ${exception.reason}

EXISTING SIGNED REPORT (from PowerScribe)
"""
${reportText || '(report text unavailable)'}
"""

Drafting radiologist: ${radiologistName || 'the signing radiologist'}

Draft an addendum that resolves the billing exception if — and only if — the report text supports \
it. If the report does not support a definitive reconciliation, draft a clarification and flag it \
for review.`;
}

// JSON schema for a predictable, parseable result.
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    addendum: {
      type: 'string',
      description: 'The drafted addendum text, beginning with "ADDENDUM:".',
    },
    needs_review: {
      type: 'boolean',
      description:
        'True when the report does not contain enough information to definitively resolve the '
        + 'exception and the radiologist must confirm a clinical fact.',
    },
    review_reason: {
      type: 'string',
      description:
        'If needs_review is true, the specific thing the radiologist must confirm. Empty string otherwise.',
    },
  },
  required: ['addendum', 'needs_review', 'review_reason'],
};

let _clientPromise = null;

async function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    const err = new Error('ANTHROPIC_API_KEY is not set — cannot draft addenda.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  if (!_clientPromise) {
    _clientPromise = (async () => {
      let Anthropic;
      try {
        ({ default: Anthropic } = await import('@anthropic-ai/sdk'));
      } catch {
        const err = new Error(
          'The @anthropic-ai/sdk package is not installed. Run `npm install` in server/.'
        );
        err.code = 'NO_SDK';
        throw err;
      }
      return new Anthropic();
    })();
  }
  return _clientPromise;
}

/**
 * Draft an addendum for a billing exception.
 *
 * @returns {Promise<{ addendum: string, needsReview: boolean, reviewReason: string, model: string }>}
 */
export async function draftAddendum({ exception, reportText, radiologistName }) {
  const client = await getAnthropic();

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    thinking: { type: 'adaptive' },
    output_config: {
      effort: 'high',
      format: { type: 'json_schema', schema: OUTPUT_SCHEMA },
    },
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: buildUserPrompt({ exception, reportText, radiologistName }) },
    ],
  });

  const textBlock = response.content.find((b) => b.type === 'text');
  let parsed;
  try {
    parsed = JSON.parse(textBlock?.text ?? '{}');
  } catch {
    // Structured output should be valid JSON; if not, surface the raw text.
    parsed = { addendum: textBlock?.text ?? '', needs_review: true, review_reason: 'Model output was not valid JSON; review carefully.' };
  }

  return {
    addendum: parsed.addendum ?? '',
    needsReview: Boolean(parsed.needs_review),
    reviewReason: parsed.review_reason ?? '',
    model: response.model ?? MODEL,
  };
}
