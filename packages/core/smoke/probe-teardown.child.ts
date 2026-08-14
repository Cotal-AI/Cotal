/** One probe, then fall off the end. Driven by `probe-teardown.smoke.ts` (#389).
 *
 *  Nothing here keeps the event loop alive on purpose: no timer, no server, no stdin reader. So
 *  whether this process EXITS is a direct read of whether `probeConnect` released its socket. If it
 *  leaked one, `RETURNED` prints and the process then sits there until its parent kills it.
 *  argv: <address> <timeoutMs> */
import { probeConnect } from "../src/endpoint.js";

const [addr, timeoutMs] = [process.argv[2]!, Number(process.argv[3])];
if (/cotal\.ai/i.test(addr)) throw new Error(`refusing to run: ${addr} names a real deployment`);

const started = Date.now();
const result = await probeConnect(addr, { timeoutMs });
console.log(JSON.stringify({ addr, timeoutMs, returnedAt: Date.now() - started, result }));
console.log("RETURNED");
