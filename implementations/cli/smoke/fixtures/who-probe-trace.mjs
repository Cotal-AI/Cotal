// Diagnostic child only: record the native classifier's result after its unchanged body returns.
// No error message, broker address or credential is written. This requires Node 22.15+ load hooks.
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registerHooks } from "node:module";

const trace = process.env.SMOKE_WHO_PROBE_TRACE;
if (!trace) throw new Error("missing who probe trace path");
const write = (record) => appendFileSync(trace, `${JSON.stringify(record)}\n`);
write({ kind: "hook-registered", node: process.versions.node });
registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!new URL(url).pathname.endsWith("/packages/core/dist/endpoint.js")) return loaded;
    if (loaded.format !== "module" || loaded.source == null) throw new Error("unexpected core probe module format");
    const source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    const anchor = "function classifyProbeFailure(e, opts) {";
    if (source.split(anchor).length !== 2) throw new Error("native probe classifier anchor is not unique");
    write({ kind: "module-matched", sourceSha256: createHash("sha256").update(source).digest("hex") });
    const replacement = `function classifyProbeFailure(e, opts) {
      const result = __cotalOriginalProbeFailure(e, opts);
      const tag = value => typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "other";
      __cotalProbeAppend(process.env.SMOKE_WHO_PROBE_TRACE, JSON.stringify({
        kind: "classification", reason: result.ok ? "ok" : result.reason,
        gateMiss: e === undefined, constructor: e === undefined ? null : tag(e?.constructor?.name),
        name: e === undefined ? null : tag(e?.name), code: e === undefined ? null : tag(e?.code),
        authorization: e instanceof AuthorizationError, expired: e instanceof UserAuthenticationExpiredError,
        timeout: e instanceof TimeoutError, credentialPresented: Boolean(opts.creds || opts.token || opts.user || opts.pass)
      }) + "\\n");
      return result;
    }
    function __cotalOriginalProbeFailure(e, opts) {`;
    return { ...loaded, source: 'import { appendFileSync as __cotalProbeAppend } from "node:fs";\n' + source.replace(anchor, replacement), shortCircuit: true };
  },
});
