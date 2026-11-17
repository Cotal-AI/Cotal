/** Contract edge cases complement the live broker regression in bin/smoke. */
import nodeAssert from "node:assert/strict";
import type { NatsConnection } from "@nats-io/transport-node";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { drainAndClose } from "../src/connection-cleanup.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const pending = () => new Promise<void>(() => {});
function connection(overrides: Partial<NatsConnection> = {}) {
  let closes = 0;
  const nc = {
    isClosed: () => false,
    closed: pending,
    drain: async () => {},
    close: async () => { closes++; },
    ...overrides,
  } as NatsConnection;
  return { nc, closes: () => closes };
}

{
  const test = connection({ drain: () => Promise.reject(new Error("drain failed")) });
  await assert.doesNotReject(drainAndClose(test.nc));
  assert.equal(test.closes(), 1);
}
{
  const error = new Error("synchronous drain failure");
  const test = connection({ drain: () => { throw error; } });
  await assert.rejects(drainAndClose(test.nc), (caught) => caught === error);
  assert.equal(test.closes(), 1);
}
{
  const error = new Error("close failed");
  const test = connection({ close: async () => { throw error; } });
  await assert.rejects(drainAndClose(test.nc), (caught) => caught === error);
}
{
  const test = connection({ isClosed: () => true, drain: () => { throw new Error("must not drain a closed connection"); } });
  await drainAndClose(test.nc);
  assert.equal(test.closes(), 1);
}
{
  let reject!: (error: Error) => void;
  const drain = new Promise<void>((_resolve, no) => { reject = no; });
  const test = connection({ drain: () => drain, closed: async () => undefined });
  await drainAndClose(test.nc, 60_000);
  assert.equal(test.closes(), 1);
  reject(new Error("late drain rejection"));
  await new Promise<void>((resolve) => setImmediate(resolve));
}
console.log("connection cleanup contract edges passed");
emitSentinel({ passed: counted.cells(), failed: 0 });
