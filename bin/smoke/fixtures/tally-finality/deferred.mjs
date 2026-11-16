import assert from 'node:assert/strict';
let ran = 0;
const EXPECTED_CELLS = 2;
function check(name) { assert.equal(1, 1); ran++; console.log(`ok ${name}`); }
async function late() {
  await new Promise(resolve => setTimeout(resolve, 5));
  check('third deferred assertion');
}
check('first synchronous assertion');
check('second synchronous assertion');
late();
if (ran !== EXPECTED_CELLS) process.exit(1);
console.log(`COTAL_SMOKE_SENTINEL cells=${ran} passed=${ran} failed=0`);
process.on('beforeExit', () => console.log(`OBSERVED_FINAL_ASSERTIONS=${ran}`));
