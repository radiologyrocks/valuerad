import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../lib/csv.js';

test('parses simple CSV into keyed objects', () => {
  const rows = parseCsv('payer,expected,paid\nAetna,1000,950\nBCBS,2000,1600\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { payer: 'Aetna', expected: '1000', paid: '950' });
  assert.equal(rows[1].payer, 'BCBS');
});

test('handles quoted fields with commas and escaped quotes', () => {
  const rows = parseCsv('name,note\n"Smith, John","said ""hi"""\n');
  assert.equal(rows[0].name, 'Smith, John');
  assert.equal(rows[0].note, 'said "hi"');
});

test('handles embedded newlines in quotes and trailing row without newline', () => {
  const rows = parseCsv('a,b\n"line1\nline2",x');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].a, 'line1\nline2');
  assert.equal(rows[0].b, 'x');
});

test('skips blank lines and tolerates CRLF', () => {
  const rows = parseCsv('a,b\r\n1,2\r\n\r\n3,4\r\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.a), ['1', '3']);
});
