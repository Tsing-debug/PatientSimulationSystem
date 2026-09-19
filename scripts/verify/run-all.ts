/** CRC-main-track verification runner. Legacy ER / GP checks are available
 * separately via `npm run verify:legacy` and do not block the CRC release.
 */

import { verifyCrcAssets } from './crc-assets.ts';

type Violation = { case: string; rule: string; detail: string };

const checks: Array<{ name: string; run: () => Violation[] }> = [
  { name: 'crc-assets', run: verifyCrcAssets },
];

let totalViolations = 0;
for (const c of checks) {
  const violations = c.run();
  totalViolations += violations.length;
  if (violations.length === 0) {
    console.log(`PASS  ${c.name}`);
    continue;
  }
  console.log(`FAIL  ${c.name}  (${violations.length})`);
  for (const v of violations) {
    console.log(`      [${v.case}] ${v.rule}: ${v.detail}`);
  }
}

if (totalViolations > 0) {
  console.log(`\n${totalViolations} violation(s) across ${checks.length} check(s).`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} checks passed.`);
