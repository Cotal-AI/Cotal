/** Runtime checks on the public trusted-host API run before any argument or connection effect. */
import assert from "node:assert/strict";
import { runAuthService, openAuthAuthorityPlane, type AuthServiceRuntimeOptions, type OpenAuthAuthorityPlaneOptions } from "@cotal-ai/auth";
import type { ParsedArgs } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";

let checks = 0;
for (const value of ["", "remote-first", false, null]) {
  let touched = 0;
  const args = { get values(): ParsedArgs["values"] { touched++; throw new Error("fixture argument effect"); }, positionals: [], raw: [] } as ParsedArgs;
  const options = { interactiveManagerSelection: value } as unknown as AuthServiceRuntimeOptions;
  await assert.rejects(() => runAuthService(args, undefined, options), /interactiveManagerSelection must be "local-primary"/); checks++;
  assert.equal(touched, 0); checks++;
  const plane = { ...options, get server() { touched++; throw new Error("fixture connection effect"); } } as unknown as OpenAuthAuthorityPlaneOptions;
  await assert.rejects(() => openAuthAuthorityPlane(plane), /interactiveManagerSelection must be "local-primary"/); checks++;
  assert.equal(touched, 0); checks++;
}
for (const value of [null, [], "local-primary"]) {
  const args = { get values(): ParsedArgs["values"] { throw new Error("fixture argument effect"); }, positionals: [], raw: [] } as ParsedArgs;
  await assert.rejects(() => runAuthService(args, undefined, value as unknown as AuthServiceRuntimeOptions), /runtime options must be an object/); checks++;
}
for (const options of [undefined, {}]) {
  let touched = 0;
  const args = { get values(): ParsedArgs["values"] { touched++; throw new Error("fixture argument effect"); }, positionals: [], raw: [] } as ParsedArgs;
  await assert.rejects(() => runAuthService(args, undefined, options), /fixture argument effect/); checks++;
  assert.equal(touched, 1); checks++;
}
// Existing native lifecycle hooks share the trusted third argument with the new policy.
for (const interactiveManagerSelection of [undefined, "local-primary"] as const) {
  let touched = 0, hooks = 0;
  const args = { get values(): ParsedArgs["values"] { touched++; throw new Error("fixture argument effect"); }, positionals: [], raw: [] } as ParsedArgs;
  const options = { root: "/owned/native-root", onReady: () => { hooks++; }, onClosed: () => { hooks++; }, ...(interactiveManagerSelection ? { interactiveManagerSelection } : {}) };
  await assert.rejects(() => runAuthService(args, undefined, options), /fixture argument effect/); checks++;
  assert.equal(touched, 1); checks++;
  assert.equal(hooks, 0); checks++;
}
assert.equal(checks, 29);
console.log(`PASS interactive Manager runtime options: ${checks} assertions`);
emitSentinel({ passed: checks, failed: 0 });
