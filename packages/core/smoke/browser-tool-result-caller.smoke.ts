/**
 * The browser tool-result caller's packaged contract, pins and refusals, without a broker (no test
 * runner). Calls against a real serving instance (consent, read, revoke, the epoch refusal and the
 * no-replay rule on a lost reply) are the final-audit live cells.
 *
 *  1. CONTRACT: this build packages exactly one `urn:cotal:tool-results` r1 cluster, its document
 *     rebuilt from the canonical `TOOL_RESULT_CONTRACTS` digests to the packaged cluster digest, and
 *     every command's closures are the canonical schemas' closures, targeted and `handle`-only.
 *  2. ISOLATION: no Manager surface includes the tool-results cluster, and an unpackaged closure or
 *     cluster refuses `unsupported-version`.
 *  3. ANSWERS: the packaged output validators accept every answer state and the falsey values
 *     (`""`, `"0"`, `"false"`, `"null"`, `0`, `false`) and refuse an unknown state, an unknown field
 *     and an answer without a state, so no state is inferred from another.
 *  4. PINS: a bearer for another target owner, actor or lifecycle, another holder, another space, a
 *     consent naming another holder, a `manager-caller`, agent or admin bearer, no consent, and a
 *     malformed bearer refuse BEFORE any dial; so do a missing or malformed responder epoch.
 *  5. LIFECYCLE: an aborted open never acquires, and the matching bearer reaches the dial.
 *
 * Run: pnpm smoke:browser-tool-result-caller
 */
import { singleDocumentClosure } from "../src/schema-profile.js";
import { EpEnvelopeError } from "../src/endpoint-error.js";
import { PACKAGED_MANAGER_CLUSTERS, PACKAGED_TOOL_RESULT_CLUSTERS, packagedContract, packagedServiceSurface } from "../src/browser.js";
import { openBrowserToolResultCaller, packagedToolResultSurface } from "../src/browser-tool-result-caller.js";
import { TOOL_RESULT_COMMAND, TOOL_RESULT_COMMANDS, TOOL_RESULT_CONSENT_COMMAND, TOOL_RESULT_CONTRACTS } from "../src/tool-result-contract.js";
import { base64url } from "../src/base64url.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const code = (f: () => unknown): string | undefined => {
  try { f(); return undefined; } catch (e) { return e instanceof EpEnvelopeError ? e.code : `non-envelope: ${String(e)}`; }
};

// ---- 1. contract ----
const digestOf = (root: unknown) => singleDocumentClosure(root).closureDigest;
check("exactly one tool-results cluster is packaged", PACKAGED_TOOL_RESULT_CLUSTERS.length === 1, PACKAGED_TOOL_RESULT_CLUSTERS);
const packaged = PACKAGED_TOOL_RESULT_CLUSTERS[0]!;
const canonicalDocument = {
  urn: "urn:cotal:tool-results",
  revision: 1,
  attributes: [],
  events: [],
  commands: TOOL_RESULT_COMMANDS.map((name) => ({
    name, class: "ephemeral", targeted: true, modes: ["handle"], capability: "tool-results",
    inputDigest: digestOf(TOOL_RESULT_CONTRACTS[name].input), outputDigest: digestOf(TOOL_RESULT_CONTRACTS[name].output),
  })),
};
check("the canonical cluster document digests to the packaged cluster digest", digestOf(canonicalDocument) === packaged.clusterDigest, { canonical: digestOf(canonicalDocument), packaged: packaged.clusterDigest });
let closures = 0;
for (const name of TOOL_RESULT_COMMANDS) {
  const cmd = packaged.commands.find((c) => c.name === name);
  const same = cmd !== undefined && cmd.inputDigest === digestOf(TOOL_RESULT_CONTRACTS[name].input) && cmd.outputDigest === digestOf(TOOL_RESULT_CONTRACTS[name].output);
  if (same) closures += 2;
  check(`${name}: packaged closures are the canonical schemas', targeted and handle-only`, same && cmd!.targeted && cmd!.modes.length === 1 && cmd!.modes[0] === "handle", cmd);
}
check(`six command closures compared (${closures})`, closures === 6, closures);
const surface = packagedToolResultSurface();
check("the caller surface has exactly the three commands", surface.size === 3 && TOOL_RESULT_COMMANDS.every((n) => surface.has(n)), [...surface.keys()]);

// ---- 2. isolation ----
check("no Manager cluster list includes the tool-results cluster", !PACKAGED_MANAGER_CLUSTERS.some((c) => c.clusterDigest === packaged.clusterDigest || c.urn === packaged.urn), PACKAGED_MANAGER_CLUSTERS.map((c) => c.urn));
check("a Manager descriptor naming the tool-results cluster refuses unsupported-version",
  code(() => packagedServiceSurface({ clusters: [{ digest: packaged.clusterDigest, commands: [...TOOL_RESULT_COMMANDS] }] })) === "unsupported-version");
check("an unpackaged closure refuses unsupported-version", code(() => packagedContract(`sha256:${"0".repeat(64)}`)) === "unsupported-version");

// ---- 3. answers ----
const out = (name: string) => packagedContract(packaged.commands.find((c) => c.name === name)!.outputDigest);
const read = out(TOOL_RESULT_COMMAND);
const pair = { threadId: "t-1", toolCallId: "c-1" };
const accepted: unknown[] = [
  ...["", "0", "false", "null"].map((content) => ({ state: "available", ...pair, content, truncated: false, bytes: 0, isError: false, capturedAt: 0 })),
  { state: "available", ...pair, content: "x", truncated: true, bytes: 9, isError: true, capturedAt: 1 },
  { state: "pending", ...pair }, { state: "not-shared" }, { state: "missing" }, { state: "expired" },
];
const refusedAnswers: unknown[] = [{ state: "redacted" }, { state: "missing", note: "x" }, {}, { state: "available", ...pair, bytes: -1 }, null];
check(`every answer state and falsey value is accepted (${accepted.length})`, accepted.every((v) => read.check(v).ok), accepted.filter((v) => !read.check(v).ok));
check(`unknown, extra and stateless answers are refused (${refusedAnswers.length})`, refusedAnswers.every((v) => !read.check(v).ok), refusedAnswers.filter((v) => read.check(v).ok));
const consentOut = out(TOOL_RESULT_CONSENT_COMMAND);
check("consent answers active, revoked and unknown are accepted, exp 0 included",
  [{ state: "active", id: "i".repeat(16), exp: 0 }, { state: "revoked" }, { state: "unknown" }].every((v) => consentOut.check(v).ok));
check("a consent answer outside the three states is refused", !consentOut.check({ state: "accepted" }).ok);

// ---- 4. pins refuse before any dial ----
const space = "browsertools";
const holder = { owner: "u_owner", actor: "web", lifecycleUid: "a".repeat(26) };
const target = { owner: "u_owner", actor: "coder", lifecycleUid: "b".repeat(26) };
const jwt = (claims: unknown) => `e30.${base64url(new TextEncoder().encode(JSON.stringify(claims)))}.sig`;
const grant = { v: 1, id: "g".repeat(22), space, scope: "tool-results", target, holder: { id: `${holder.owner}.${holder.actor}` }, proofAt: 1, iat: 2, exp: 3, issuer: { keyId: "k" }, sig: "s" };
const good = { sub: holder.owner, aud: space, act: { view: "tool-result-caller", owner: holder.owner, actor: holder.actor, lifecycleUid: holder.lifecycleUid, toolResult: grant } };
const variants: Array<[string, string]> = [
  ["another target owner", jwt({ ...good, act: { ...good.act, toolResult: { ...grant, target: { ...target, owner: "u_other" } } } })],
  ["another target actor", jwt({ ...good, act: { ...good.act, toolResult: { ...grant, target: { ...target, actor: "other" } } } })],
  ["another target lifecycle", jwt({ ...good, act: { ...good.act, toolResult: { ...grant, target: { ...target, lifecycleUid: "c".repeat(26) } } } })],
  ["another holder lifecycle", jwt({ ...good, act: { ...good.act, lifecycleUid: "d".repeat(26) } })],
  ["another holder principal", jwt({ ...good, sub: "u_other", act: { ...good.act, owner: "u_other" } })],
  ["another space", jwt({ ...good, aud: "otherspace" })],
  ["a consent for another space", jwt({ ...good, act: { ...good.act, toolResult: { ...grant, space: "otherspace" } } })],
  ["a consent naming another holder", jwt({ ...good, act: { ...good.act, toolResult: { ...grant, holder: { id: `${holder.owner}.other` } } } })],
  ["a manager-caller view", jwt({ ...good, act: { ...good.act, view: "manager-caller", managerInstanceId: target.lifecycleUid } })],
  ["an agent bearer", jwt({ ...good, act: { owner: holder.owner, actor: holder.actor, lifecycleUid: holder.lifecycleUid } })],
  ["an admin view", jwt({ ...good, act: { ...good.act, view: "admin" } })],
  ["no consent", jwt({ ...good, act: { ...good.act, toolResult: undefined } })],
  ["a malformed bearer", "not-a-bearer"],
];
const base = { servers: "ws://127.0.0.1:9", space, holder, target, deadlineMs: 500 };
const opened = async (acquire: () => Promise<{ bearer: string; sentinelCreds: string; responderEpoch: number }>, signal?: AbortSignal): Promise<string> => {
  try { await openBrowserToolResultCaller({ ...base, acquire }, signal); return "opened"; }
  catch (e) { return e instanceof Error ? e.message : String(e); }
};
const PIN = /tool-result exchange|responder epoch/;
for (const [what, bearer] of variants) {
  let acquired = 0;
  const refusal = await opened(async () => { acquired++; return { bearer, sentinelCreds: "unused", responderEpoch: 1 }; });
  check(`a bearer for ${what} refuses before any dial`, acquired === 1 && PIN.test(refusal), refusal);
}
for (const [what, epoch] of [["no", undefined], ["a negative", -1], ["a fractional", 1.5], ["a string", "1"]] as const) {
  const refusal = await opened(async () => ({ bearer: jwt(good), sentinelCreds: "unused", responderEpoch: epoch as unknown as number }));
  check(`${what} responder epoch refuses before any dial`, /responder epoch/.test(refusal), refusal);
}

// ---- 5. lifecycle ----
let acquiredAfterAbort = 0;
const aborted = new AbortController();
aborted.abort();
await opened(async () => { acquiredAfterAbort++; return { bearer: jwt(good), sentinelCreds: "unused", responderEpoch: 1 }; }, aborted.signal);
check("an aborted open never acquires authority", acquiredAfterAbort === 0, acquiredAfterAbort);
const reached = await opened(async () => ({ bearer: jwt(good), sentinelCreds: "unused", responderEpoch: 1 }));
check("CONTROL: the matching bearer and epoch pass every pin and reach the dial", reached !== "opened" && !PIN.test(reached), reached);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0 || pass !== 33) process.exit(1);
