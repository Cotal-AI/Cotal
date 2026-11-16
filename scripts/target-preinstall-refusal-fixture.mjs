// Test-only declared target entry. Include only in an independently built fixture package.
// It runs the real target admission first and invents no successful receipt.
import {readExecutionPreinstall} from './daemon/execution-preinstall.js';
const request=JSON.parse(process.argv[2]);
await readExecutionPreinstall(request);
process.stderr.write('target-preinstall-cell: target-only policy refuses before publication\n');
process.exitCode=7;
