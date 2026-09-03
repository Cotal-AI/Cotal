import { activityBackfill, type ActivitySource } from "../src/web.js";
import type { CotalMessage } from "@cotal-ai/core";

let pass = 0;
let fail = 0;
const check = (name: string, condition: boolean, detail?: unknown): void => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

const signals: AbortSignal[] = [];
const stalled = (signal?: AbortSignal): Promise<CotalMessage[]> => {
  if (!signal) return Promise.reject(new Error("source received no cancellation signal"));
  signals.push(signal);
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve([]), { once: true }));
};
const src: ActivitySource = {
  listChannels: async () => [
    { channel: "slow-a", messages: 1 },
    { channel: "slow-b", messages: 1 },
  ],
  channelHistory: async (_channel, opts) => stalled(opts.signal),
  dmHistory: async (opts) => stalled(opts.signal),
};

// Production unrefs its deadline so a dashboard poll never holds the server open. This standalone
// smoke has no server handle, so keep the process alive only until that real deadline completes.
const keepAlive = setInterval(() => {}, 1_000);
const page = await activityBackfill(src, 10, 100, 3).finally(() => clearInterval(keepAlive));
check("every started history source receives the shared cancellation signal", signals.length === 3, signals.length);
check("the response deadline aborts every abandoned source", signals.every((signal) => signal.aborted), signals.map((signal) => signal.aborted));
check("cancellation preserves the named partial response", page.partial && page.read === 0 && page.missing.length === 3, page);

console.log(`WEB HISTORY CANCELLATION: ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
