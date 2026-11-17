import nodeAssert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { assertSmokeProof, assertSmokeProofCoverage, type ProofEntry } from "./presence-render-proofs.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const manifest = JSON.parse(read("packages/workspace/smoke/fixtures/presence-render-sinks.json")) as { entries: ProofEntry[] };
const checked = assertSmokeProofCoverage(manifest.entries, read);

const path = "implementations/web/smoke/views.smoke.ts";
const body = read(path);
const channel = { path, anchor: 'ok("3.3 a member whose connector reports no progress reads working with its activity, with no moving dots"' };
const dm = { path, anchor: 'ok("7.9 a conversation draws the working line for its working party only, after its messages"' };
const dmModule = "implementations/web/client/src/ui/views/DmView.tsx";
const channelModule = "implementations/web/client/src/ui/views/ChannelView.tsx";
const agentModule = "implementations/web/client/src/ui/views/AgentPage.tsx";
const sink = "rows={working}";
assert.doesNotThrow(() => assertSmokeProof(dmModule, dm, body, sink));
assert.doesNotThrow(() => assertSmokeProof(channelModule, channel, body, sink));
for (const [module, proof] of [
  [dmModule, channel],
  [channelModule, dm],
  [dmModule, { path, anchor: 'ok("3.2 a working agent who is not in the channel is not named"' }],
  [agentModule, { path, anchor: 'ok("3.8 a channel where only a waiting member is busy has no working line and no chip"' }],
  ["unreviewed-module.tsx", dm],
] as const) {
  assert.throws(() => assertSmokeProof(module, proof, body, sink), /smoke proof has no reviewed output coverage/);
}
assert.throws(() => assertSmokeProof(dmModule, { path: "other/smoke/views.smoke.ts", anchor: dm.anchor }, body, sink), /smoke proof has no reviewed output coverage/);
assert.throws(() => assertSmokeProof(dmModule, { path, anchor: 'ok("missing output assertion"' }, body, sink), /proof anchor must exist exactly once/);
assert.throws(() => assertSmokeProof(dmModule, dm, body + dm.anchor, sink), /proof anchor must exist exactly once/);
assert.throws(() => assertSmokeProof(dmModule, { path, anchor: "const workingLines =" }, body, sink), /smoke proof is not an output assertion/);
assert.throws(() => assertSmokeProof(dmModule, dm, body, "unreviewed sink"), /smoke proof has no reviewed output coverage/);

// A proof of one sink must not license every other sink in the same module.
const agentHeader = { path: "implementations/web/smoke/session-view.smoke.ts", anchor: 'ok("5.3 the header Badge says the status presence reports, Working, for an agent whose progress is unknown, with no progress claim"' };
const agentBody = read(agentHeader.path);
const agentWork = manifest.entries.filter((entry) => entry.path === agentModule && entry.class === "honest-text" && entry.proof?.anchor !== agentHeader.anchor);
assert.equal(agentWork.length, 6);
for (const entry of agentWork) {
  assert.throws(() => assertSmokeProof(entry.path, agentHeader, agentBody, entry.anchor), /smoke proof has no reviewed output coverage/);
}
const toolEntries = manifest.entries.filter((entry) => entry.path === "extensions/connector-core/src/tool-specs.ts" && entry.proof?.path.includes("/smoke/"));
const roster = toolEntries.find((entry) => entry.proof!.path.endsWith("/orientation.smoke.ts"))!;
const anycast = toolEntries.find((entry) => entry.proof!.anchor.startsWith('check("9a'))!;
for (const [entry, proof] of [[roster, anycast.proof!], [anycast, roster.proof!]] as const) {
  assert.throws(() => assertSmokeProof(entry.path, proof, read(proof.path), entry.anchor), /smoke proof has no reviewed output coverage/);
}
const helperProof = { path: "implementations/web/smoke/session.smoke.ts", anchor: 'ok("turn title: open while working reads \\"Working for 3m 2s\\""' };
for (const entry of manifest.entries.filter((entry) => /\/(SessionPreview|Turn)\.tsx$/.test(entry.path) && entry.class === "honest-text")) {
  assert.throws(() => assertSmokeProof(entry.path, helperProof, read(helperProof.path), entry.anchor), /smoke proof has no reviewed output coverage/);
}

// A negative render control and a formatter-only check cannot prove positive output sinks.
const liveModule = "implementations/web/client/src/ui/views/AgentsView.tsx";
const livePath = "implementations/web/smoke/agents-view.smoke.ts";
const finished = { path: livePath, anchor: 'ok("11.6 a working row whose call has finished shows no step line, and keeps View work"' };
for (const anchor of ["call={running.call}", "{running.call}"]) {
  assert.throws(() => assertSmokeProof(liveModule, finished, read(livePath), anchor), /smoke proof has no reviewed output coverage/);
}
const watchHelper = { path: "implementations/cli/smoke/view.smoke.ts", anchor: 'check("the watch roster names a working agent\'s progress as unknown"' };
for (const entry of manifest.entries.filter((entry) => entry.class === "honest-text" && /\/watch-(json\.ts|view\.tsx)$/.test(entry.path))) {
  assert.throws(() => assertSmokeProof(entry.path, watchHelper, read(watchHelper.path), entry.anchor), /smoke proof has no reviewed output coverage/);
}

// Invalid in-memory records exercise validation without changing sources or fixtures on disk.
const selected = manifest.entries.find((entry) => entry.path === dmModule && entry.anchor === sink)!;
const replace = (replacement: ProofEntry) => manifest.entries.map((entry) => entry === selected ? replacement : entry);
assert.throws(() => assertSmokeProofCoverage(replace({ ...selected, proof: undefined }), read), /lacks output\/shared-renderer proof/);
assert.throws(() => assertSmokeProofCoverage(replace({ ...selected, path: "missing-module.tsx" }), read), /ENOENT/);
assert.throws(() => assertSmokeProofCoverage(replace({ ...selected, anchor: "renamed sink" }), read), /manifest anchor must exist exactly once/);
assert.throws(() => assertSmokeProofCoverage(manifest.entries.filter((entry) => entry !== selected), read), /unused smoke proof binding/);
assert.throws(() => assertSmokeProofCoverage(replace({ ...selected, class: "non-render/control", proof: undefined }), read), /unused smoke proof binding/);
assert.throws(() => assertSmokeProofCoverage([], read), /unused smoke proof binding/);
console.log(`presence-render smoke proofs: ${checked} manifest entries checked`);
emitSentinel({ passed: cells(), failed: 0 });
