/**
 * Re-pin the catalog eval baselines after a DELIBERATE engine or catalog
 * change. Review the diff of evalBaselines.json like any other code change —
 * it is the record of "the numbers moved and we meant it". Bump
 * ENGINE_VERSION (domain/dsl.js) when the change alters metric contracts.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeCatalogBaselines } from '../domain/evals.js';

const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'domain', 'evalBaselines.json');
const baselines = computeCatalogBaselines();
writeFileSync(path, JSON.stringify(baselines, null, 2) + '\n');
console.log(`pinned ${Object.keys(baselines).length} catalog baselines -> ${path}`);
