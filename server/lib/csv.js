/**
 * Minimal, dependency-free CSV parser for BI extracts.
 *
 * Handles quoted fields, embedded commas/newlines, and "" escaping. Returns an
 * array of objects keyed by the header row. Values stay strings — the metric
 * functions in domain/bi.js coerce with Number() where needed, so RCM/RIS
 * exports drop in without a mapping step.
 */

export function parseCsv(text) {
  const rows = parseRows(String(text ?? ''));
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1)
    .filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''))
    .map((r) => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = r[i] ?? ''; });
      return obj;
    });
}

function parseRows(text) {
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
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; }
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') { /* ignore; handled by \n */ }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += c; }
  }
  // Flush trailing field/row (no final newline).
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}
