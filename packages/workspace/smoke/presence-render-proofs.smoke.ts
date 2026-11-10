import nodeAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertSmokeProof, type SmokeProof } from "./presence-render-proofs.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const manifest = JSON.parse(readFileSync(join(root, "packages/workspace/smoke/fixtures/presence-render-sinks.json"), "utf8")) as {
  entries: { path: string; class: string; proof?: SmokeProof }[];
};
let checked = 0;
for (const entry of manifest.entries) {
  if (entry.class !== "honest-text" || !entry.proof?.path.includes("/smoke/")) continue;
  const proof = entry.proof;
  assert.doesNotThrow(() => assertSmokeProof(entry.path, proof, readFileSync(join(root, proof.path), "utf8")));
  checked++;
}
assert.ok(checked > 0, "manifest must exercise smoke proof coverage");

const path = "implementations/web/smoke/views.smoke.ts";
const body = readFileSync(join(root, path), "utf8");
const channel = { path, anchor: 'ok("3.3 a member whose connector reports no progress reads working with its activity, with no moving dots"' };
const dm = { path, anchor: 'ok("7.9 a conversation draws the working line for its working party only, after its messages"' };
const dmModule = "implementations/web/client/src/ui/views/DmView.tsx";
const channelModule = "implementations/web/client/src/ui/views/ChannelView.tsx";
const agentModule = "implementations/web/client/src/ui/views/AgentPage.tsx";
assert.doesNotThrow(() => assertSmokeProof(dmModule, dm, body));
assert.doesNotThrow(() => assertSmokeProof(channelModule, channel, body));
assert.doesNotThrow(() => assertSmokeProof("implementations/web/client/src/ui/WorkingLine.tsx", channel, body));
for (const [module, proof] of [
  [dmModule, channel],
  [channelModule, dm],
  [dmModule, { path, anchor: 'ok("3.2 a working agent who is not in the channel is not named"' }],
  [agentModule, { path, anchor: 'ok("3.8 a channel where only a waiting member is busy has no working line and no chip"' }],
  ["unreviewed-module.tsx", dm],
] as const) {
  assert.throws(() => assertSmokeProof(module, proof, body), /smoke proof has no reviewed output coverage/);
}
assert.throws(() => assertSmokeProof(dmModule, { path: "other/smoke/views.smoke.ts", anchor: dm.anchor }, body), /smoke proof has no reviewed output coverage/);
assert.throws(() => assertSmokeProof(dmModule, { path, anchor: 'ok("missing output assertion"' }, body), /proof anchor must exist exactly once/);
assert.throws(() => assertSmokeProof(dmModule, dm, body + dm.anchor), /proof anchor must exist exactly once/);
assert.throws(() => assertSmokeProof(dmModule, { path, anchor: "const workingLines =" }, body), /smoke proof is not an output assertion/);
console.log(`presence-render smoke proofs: ${checked} manifest entries checked`);
emitSentinel({ passed: cells(), failed: 0 });
