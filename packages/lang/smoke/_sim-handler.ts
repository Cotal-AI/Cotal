/**
 * A handler FACTORY, which is the shape the worker asks for.
 *
 * A handler is not serialisable and must not be - it holds sockets, a client and a clock - so a
 * worker request names a module and the thread builds the handler there. This is the simulator's
 * one, for suites; a mesh host ships its own module with the same one-function shape.
 */

import { SimHandler } from "../src/sim.js";

export function createHandler(config: unknown): SimHandler {
  return new SimHandler((config ?? {}) as ConstructorParameters<typeof SimHandler>[0]);
}
