/** Run the SHIPPED `web` command entry point in a child process, so a smoke can read the
 *  dashboard's real HTTP surface rather than a copy of it.
 *
 *  `implementations/web/src/index.ts` registers this exact function as the `web` command's `run`,
 *  and `web()` serves until it is signalled, so it cannot be awaited in-process by a suite that has
 *  assertions after it. Argument parsing here is the flag subset the suite passes; anything else is
 *  ignored rather than guessed at.
 *
 *  Not shipped and not imported by shipped code: this file lives under `smoke/`. */
import { CotalEndpoint, spacePrefix } from "@cotal-ai/core";
import { web } from "../src/web.js";

/** An event channel's history is refused the way a broker refuses a read the credential does not
 *  carry, so a suite can read the events route's answer to a refusal on an open mesh. Every other
 *  channel reads normally. */
if (process.env.COTAL_WEB_SMOKE_REFUSE_EVENTS === "1") {
  const channelHistory = CotalEndpoint.prototype.channelHistory;
  CotalEndpoint.prototype.channelHistory = function (channel, opts) {
    return channel.startsWith("events.")
      ? Promise.reject(new Error(`Permissions Violation for Subscription to "${spacePrefix(this.space)}.chat.${opts?.publisher ? `${opts.publisher.owner}.${opts.publisher.actor}` : "*.*"}.${channel}"`))
      : channelHistory.call(this, channel, opts);
  };
}

if (process.env.COTAL_WEB_SMOKE_REJECT_HISTORY === "1") {
  CotalEndpoint.prototype.dmHistory = async () => { throw new Error("timeout"); };
  CotalEndpoint.prototype.channelHistory = async () => { throw new Error("timeout"); };
}

if (process.env.COTAL_WEB_SMOKE_HANG_DMS === "1")
  CotalEndpoint.prototype.dmHistory = (opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener("abort", () => reject(opts.signal?.reason), { once: true });
  });

/** A post whose text is this marker is refused the way the broker refuses a publish it does not
 *  allow, so a suite can read the route's answer to a refusal without breaking the mesh. */
const refuseText = process.env.COTAL_WEB_SMOKE_REFUSE_TEXT;
if (refuseText) {
  const refusal = () => Promise.reject(new Error(`Permissions Violation for Publish (${refuseText})`));
  const multicast = CotalEndpoint.prototype.multicast;
  const unicastAttributed = CotalEndpoint.prototype.unicastAttributed;
  CotalEndpoint.prototype.multicast = function (text, opts) {
    return text === refuseText ? refusal() : multicast.call(this, text, opts);
  };
  CotalEndpoint.prototype.unicastAttributed = function (to, text, opts) {
    return text === refuseText ? refusal() : unicastAttributed.call(this, to, text, opts);
  };
}

const raw = process.argv.slice(2);
const values: Record<string, string | boolean> = {};
for (let i = 0; i < raw.length; i++) {
  const a = raw[i];
  if (!a.startsWith("--")) continue;
  const next = raw[i + 1];
  if (next && !next.startsWith("--")) { values[a.slice(2)] = next; i++; } else values[a.slice(2)] = true;
}
await web({ values, positionals: [], raw } as never);
