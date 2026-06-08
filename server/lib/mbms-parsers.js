/**
 * Parsers for file-based MBMS exception feeds.
 *
 * Billing companies most commonly hand off denial/exception data as files
 * rather than a live API — either a CSV/worklist export from their portal
 * (here, MBMS "Resolve") or a standard X12 835 ERA (electronic remittance
 * advice) dropped to SFTP. Both are parsed here into the same shape the rest of
 * the app consumes via `normalizeMbmsRecord`.
 *
 * These parsers are intentionally dependency-free and conservative. Real-world
 * CSVs and 835s vary by payer/vendor, so validate against actual MBMS files and
 * adjust the column map / segment handling as needed (clearly flagged below).
 */

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Minimal RFC-4180-ish CSV parser: handles quoted fields, escaped quotes
 * (""), commas and newlines inside quotes, and CRLF. Returns array of rows
 * (each an array of strings). Good enough for billing exports; swap for a
 * hardened library if MBMS files prove gnarly.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else if (c === '\r') {
      // handled by \n; ignore lone CR
    } else {
      field += c;
    }
  }
  // trailing field/row
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// Default mapping from normalized header -> BillingException field. Header
// matching is case-insensitive and ignores spaces/underscores. Override the
// whole map with MBMS_CSV_COLUMNS (JSON) if MBMS uses different headers.
const DEFAULT_CSV_MAP = {
  exceptionnumber: 'exceptionNumber',
  exceptionid: 'exceptionNumber',
  exception: 'exceptionNumber',
  accessionnumber: 'accessionNumber',
  accession: 'accessionNumber',
  acc: 'accessionNumber',
  status: 'status',
  studydescription: 'studyDescription',
  examdescription: 'studyDescription',
  procedure: 'studyDescription',
  modality: 'modality',
  mrn: 'mrn',
  patientmrn: 'mrn',
  patientname: 'patientName',
  patient: 'patientName',
  dob: 'patientDob',
  patientdob: 'patientDob',
  cpt: 'cptCode',
  cptcode: 'cptCode',
  icd10: 'icd10Codes',
  diagnosiscodes: 'icd10Codes',
  reason: 'reason',
  denialreason: 'reason',
  description: 'reason',
  payer: 'payer',
  insurance: 'payer',
  dateofservice: 'dateOfService',
  dos: 'dateOfService',
  notes: 'notes',
};

const normHeader = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Parse a CSV export of billing exceptions into raw records (pre-normalization).
 * @param {string} text - CSV content
 * @param {object} [columnMap] - normalizedHeader -> field overrides
 */
export function parseExceptionCsv(text, columnMap) {
  const rows = parseCsv(text);
  if (rows.length < 2) return [];
  const map = columnMap ?? DEFAULT_CSV_MAP;
  const headers = rows[0].map((h) => map[normHeader(h)] ?? null);
  return rows.slice(1).map((cells) => {
    const rec = {};
    headers.forEach((field, idx) => {
      if (!field) return;
      let value = (cells[idx] ?? '').trim();
      if (field === 'icd10Codes') {
        rec[field] = value ? value.split(/[;,|]/).map((s) => s.trim()).filter(Boolean) : [];
      } else {
        rec[field] = value;
      }
    });
    return rec;
  });
}

// ---------------------------------------------------------------------------
// X12 835 ERA
// ---------------------------------------------------------------------------

// Common Claim Adjustment Reason Codes (CARC) seen on radiology denials. This
// is a small starter lookup — extend from the official CARC list as needed.
export const CARC_TEXT = {
  4: 'The procedure code is inconsistent with the modifier used.',
  11: 'The diagnosis is inconsistent with the procedure.',
  16: 'Claim/service lacks information or has submission/billing error(s).',
  18: 'Exact duplicate claim/service.',
  50: 'Non-covered services — not deemed a medical necessity by the payer.',
  167: 'The diagnosis is not covered.',
  181: 'The procedure code was invalid on the date of service.',
  182: 'The procedure modifier was invalid on the date of service.',
  234: 'This procedure is not paid separately.',
};

/**
 * Parse an X12 835 ERA into raw exception records — one per denied/adjusted
 * claim. Extracts the fields we can map (claim id, CPT, CARC reasons, payer,
 * patient). The accession number is taken from a REF segment when present
 * (radiology accessions commonly ride in REF*1K/REF*BB/REF*EA), falling back to
 * the claim control number (CLP01).
 *
 * Note: 835 layouts vary; this handles the standard segment set. Validate
 * against real MBMS files and extend the REF/segment handling per their format.
 */
export function parse835(text) {
  // Detect element + segment separators. ISA is fixed-width: element separator
  // is byte 3, segment terminator is byte 105. Fall back to '*' and '~'.
  const elementSep = text[3] && text.startsWith('ISA') ? text[3] : '*';
  const segTerm = text.startsWith('ISA') && text.length > 105 ? text[105] : '~';

  const segments = text
    .split(segTerm)
    .map((s) => s.replace(/[\r\n]+/g, '').trim())
    .filter(Boolean)
    .map((s) => s.split(elementSep));

  const records = [];
  let currentPayer = '';
  let claim = null;

  const pushClaim = () => {
    if (!claim) return;
    const reasonText = claim.adjustments
      .map((a) => {
        const code = Number(a.reasonCode);
        const label = CARC_TEXT[code] ? ` ${CARC_TEXT[code]}` : '';
        return `[${a.groupCode}-${a.reasonCode}]${label}`;
      })
      .join(' ');
    records.push({
      exceptionNumber: claim.claimId,
      accessionNumber: claim.accession || claim.claimId,
      status: 'open',
      studyDescription: '',
      modality: '',
      mrn: claim.mrn,
      patientName: claim.patientName,
      cptCode: claim.cpt,
      icd10Codes: [],
      reason: reasonText || `Claim status ${claim.statusCode} (835 ERA).`,
      payer: currentPayer,
      dateOfService: claim.dos,
      notes: `835 ERA: claim ${claim.claimId}, charged ${claim.charge}, paid ${claim.paid}.`,
    });
    claim = null;
  };

  for (const seg of segments) {
    const tag = seg[0];
    if (tag === 'N1' || tag === 'NM1') {
      const entity = seg[1];
      const name = tag === 'NM1' ? (seg[3] || '') : (seg[2] || '');
      if (entity === 'PR') currentPayer = name;       // payer
      if (entity === 'QC' && claim) claim.patientName = // patient
        [seg[3], seg[4]].filter(Boolean).join(', ');
    } else if (tag === 'CLP') {
      pushClaim(); // flush previous claim
      claim = {
        claimId: seg[1] || '',
        statusCode: seg[2] || '',
        charge: seg[3] || '',
        paid: seg[4] || '',
        cpt: '',
        accession: '',
        mrn: '',
        patientName: '',
        dos: '',
        adjustments: [],
      };
    } else if (tag === 'SVC' && claim) {
      // SVC01 is a composite like HC:74178 — take the procedure code.
      const comp = (seg[1] || '').split(':');
      claim.cpt = comp[1] || comp[0] || '';
    } else if (tag === 'CAS' && claim) {
      // CAS: groupCode, reasonCode, amount, [reasonCode, amount]...
      const groupCode = seg[1];
      for (let i = 2; i < seg.length; i += 3) {
        if (seg[i]) claim.adjustments.push({ groupCode, reasonCode: seg[i], amount: seg[i + 1] });
      }
    } else if (tag === 'REF' && claim) {
      // Accession candidates: 1K (claim number), BB (authorization), 6R (line item).
      // EA is the patient's medical record number — map it to MRN, not accession.
      if (['1K', 'BB', '6R'].includes(seg[1]) && !claim.accession) {
        claim.accession = seg[2] || '';
      }
      if (seg[1] === 'EA') claim.mrn = seg[2] || '';
    } else if (tag === 'DTM' && claim) {
      // 232/472 = service date.
      if (['232', '472'].includes(seg[1])) claim.dos = formatX12Date(seg[2]);
    }
  }
  pushClaim();
  return records;
}

function formatX12Date(d = '') {
  // CCYYMMDD -> YYYY-MM-DD
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  return d;
}

/** Dispatch on content: 835 if it looks like X12, otherwise CSV. */
export function parseExceptionFile(text, { columnMap } = {}) {
  const head = text.slice(0, 16).trim();
  if (head.startsWith('ISA') || head.startsWith('ST*835')) return parse835(text);
  return parseExceptionCsv(text, columnMap);
}
