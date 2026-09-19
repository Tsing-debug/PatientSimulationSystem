/** Legacy ER / GP verification runner. These checks are intentionally kept
 * out of the CRC main-track release gate.
 */

import { verifyDataIntegrity } from './data-integrity.ts';
import { verifyTriagePriority } from './triage-priority.ts';
import { verifyThreeScene } from './three-scene.ts';
import { verifyRubricCitations } from './rubric-smoke.ts';

type Violation = { case: string; rule: string; detail: string };

const checks: Array<{ name: string; run: () => Violation[] }> = [
  { name: 'data-integrity', run: verifyDataIntegrity },
  { name: 'triage-priority', run: verifyTriagePriority },
  { name: 'three-scene', run: verifyThreeScene },
  { name: 'rubric-citations', run: verifyRubricCitations },
];

let totalViolations = 0;
for (const check of checks) {
  const violations = check.run();
  totalViolations += violations.length;
  if (violations.length === 0) {
    console.log(`PASS  ${check.name}`);
    continue;
  }
  console.log(`FAIL  ${check.name}  (${violations.length})`);
  for (const violation of violations) {
    console.log(`      [${violation.case}] ${violation.rule}: ${violation.detail}`);
  }
}

if (totalViolations > 0) {
  console.log(`\n${totalViolations} violation(s) across ${checks.length} legacy check(s).`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} legacy checks passed.`);
