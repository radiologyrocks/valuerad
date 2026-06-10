/** Run the deterministic eval suite and exit non-zero on any failure. */
import { runEvalSuite } from '../domain/evals.js';

const { ok, checks } = runEvalSuite();
for (const c of checks) {
  console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(`\n${checks.filter((c) => c.ok).length}/${checks.length} checks passed`);
process.exit(ok ? 0 : 1);
