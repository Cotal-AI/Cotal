/**
 * A handler FACTORY, which is the shape the worker asks for, BUILT AS PLAIN JAVASCRIPT ON PURPOSE.
 *
 * A handler is not serialisable and must not be - it holds sockets, a client and a clock - so a
 * worker request names a module and the thread builds the handler there. This is the simulator's
 * one, for suites; a mesh host ships its own module with the same one-function shape.
 *
 * It is `.mjs` importing `dist`, not `.ts` importing `src`, because it is imported INSIDE the worker
 * thread, and a thread is exactly where a TypeScript loader may not reach: on node 22 it does not,
 * measured. The whole worker leg of this suite runs against the BUILT package for the same reason,
 * which also means the leg grades the artifact that ships rather than a copy of it.
 */

import { SimHandler } from "../dist/sim.js";

export function createHandler(config) {
  return new SimHandler(config ?? {});
}
