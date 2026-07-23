// The reviewer endpoint daemon (`ai.cotal.reviewer`). N instances ARE the N runs: each is a
// stateless client on its OWN connection, registered and serving the three persona commands. A
// handler is a fresh model call per delivery; nothing is shared across commands, instances, or PRs.
import { serveEndpoint, type EpServeContext, type EpServeHandle } from "@cotal-ai/core";
import type { NatsConnection } from "@nats-io/transport-node";
import { PERSONAS, commandFor, inputContract, outputContract, type PrPacket } from "./contracts.js";
import { runReview, mockReview } from "./personas.js";
import { connectNats, openSpaceKv, provisionInstance } from "./space.js";

export interface Reviewer {
  instanceIds: string[];
  stop: () => Promise<void>;
}

/** Serialize the model calls of ONE instance: OpenCode's local SQLite state collides under
 *  concurrent CLI runs, and an instance can receive all three persona deliveries at once. */
function makeSerializer(): (fn: () => Promise<void>) => Promise<void> {
  let tail = Promise.resolve();
  return (fn) => {
    const next = tail.then(fn, fn);
    tail = next.catch(() => {});
    return next;
  };
}

/** Bring up N reviewer instances on the given broker + space. Returns the live instance ids and a
 *  stop() that drains every serve table and closes every connection. */
export async function startReviewer(opts: {
  url: string;
  space: string;
  instanceIds: string[];
  mock: boolean;
}): Promise<Reviewer> {
  const provisionerNc = await connectNats(opts.url);
  const kv = await openSpaceKv(provisionerNc, opts.space);
  const instances: { nc: NatsConnection; serve: EpServeHandle }[] = [];

  for (const instanceId of opts.instanceIds) {
    const grant = await provisionInstance(kv, opts.space, instanceId);
    const serveNc = await connectNats(opts.url);
    const serialize = makeSerializer();
    const defs = PERSONAS.map((persona) => ({
      command: commandFor(persona),
      contract: { input: inputContract, output: outputContract },
      handler: async (ctx: EpServeContext) => {
        const packet = ctx.request.args as unknown as PrPacket;
        if (opts.mock) return { findings: mockReview(persona, packet, instanceId) };
        let findings: Awaited<ReturnType<typeof runReview>> = [];
        await serialize(async () => { findings = await runReview(persona, packet); });
        return { findings };
      },
    }));
    const serve = serveEndpoint(serveNc, opts.space, grant, defs, { public: true });
    await serveNc.flush();
    instances.push({ nc: serveNc, serve });
  }

  return {
    instanceIds: [...opts.instanceIds],
    stop: async () => {
      await Promise.all(instances.map((i) => i.serve.stop()));
      await Promise.all(instances.map((i) => i.nc.close()));
      await provisionerNc.close();
    },
  };
}
