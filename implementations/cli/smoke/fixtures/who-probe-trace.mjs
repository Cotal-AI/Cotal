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
    const path = new URL(url).pathname;
    const sdk = path.endsWith("/@nats-io/transport-node/lib/node_transport.js") ? "transport"
      : path.endsWith("/@nats-io/nats-core/lib/protocol.js") ? "protocol" : null;
    const endpoint = path.endsWith("/packages/core/dist/endpoint.js");
    if (!sdk && !endpoint) return loaded;
    if (loaded.source == null) throw new Error("missing native diagnostic module source");
    let source = typeof loaded.source === "string" ? loaded.source : Buffer.from(loaded.source).toString("utf8");
    if (sdk) {
      const expected = sdk === "transport" ? "527474ca776b69b5ba35e5be54f23da838280b91f52d508423baf47b79b55fec" : "90a0ac36b06e7a29088fea89e2aa1815871187e39340f0df4288051f8b0c6d93";
      const sha256 = createHash("sha256").update(source).digest("hex");
      // A synchronous require load may omit format. Exact pinned bytes identify this CommonJS module.
      if (sha256 !== expected || (loaded.format !== undefined && loaded.format !== "commonjs")) throw new Error("unexpected pinned SDK diagnostic module");
      write({ kind: "sdk-module-matched", sdk, format: loaded.format ?? null, sourceSha256: sha256 });
      const prefix = `function __cotalSdkWrite(record, transport) {
        const key = Symbol.for("cotal.who.probe.trace.state");
        const state = globalThis[key] ??= { started: process.hrtime.bigint(), next: 1, ids: new WeakMap() };
        const elapsedMs = Number(process.hrtime.bigint() - state.started) / 1e6;
        if (transport) {
          if (!state.ids.has(transport)) state.ids.set(transport, state.next++);
          record = { ...record, transportId: state.ids.get(transport),
            localPort: Number.isInteger(transport.socket?.localPort) ? transport.socket.localPort : null,
            remotePort: Number.isInteger(transport.socket?.remotePort) ? transport.socket.remotePort : null };
        }
        require("node:fs").appendFileSync(process.env.SMOKE_WHO_PROBE_TRACE, JSON.stringify({ ...record, elapsedMs }) + "\\n");
      }
      function __cotalSdkTag(value) { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "other"; }
      `;
      const changes = sdk === "transport" ? [
        ["                this.socket = await this.dial(hp);", "                __cotalSdkWrite({ kind: 'sdk-await-dial' }, this);\n                this.socket = await this.dial(hp);"],
        ["            const info = await this.peekInfo();", "            __cotalSdkWrite({ kind: 'sdk-await-info' }, this);\n            const info = await this.peekInfo();\n            __cotalSdkWrite({ kind: 'sdk-info', authRequired: info.auth_required === true, tlsRequired: info.tls_required === true, tlsAvailable: info.tls_available === true }, this);"],
        ["        catch (ex) {\n            let err = ex;", "        catch (ex) {\n            __cotalSdkWrite({ kind: 'sdk-connect-rejected', code: __cotalSdkTag(ex?.code), constructor: __cotalSdkTag(ex?.constructor?.name), connected: this.connected, done: this.done, bufferedFrames: this.yields.length }, this);\n            let err = ex;"],
        ["                yield yields[i];", "                __cotalSdkWrite({ kind: 'sdk-frame', bytes: yields[i].byteLength, info: Buffer.from(yields[i]).toString('ascii').startsWith('INFO '), authViolation: Buffer.from(yields[i]).includes(Buffer.from('Authorization Violation')), authTimeout: Buffer.from(yields[i]).includes(Buffer.from('Authentication Timeout')) }, this);\n                yield yields[i];"],
        ["    send(frame) {", "    send(frame) {\n        const __cotalBytes = Buffer.from(frame);\n        __cotalSdkWrite({ kind: 'sdk-send', bytes: frame.byteLength, connect: __cotalBytes.subarray(0, 8).equals(Buffer.from('CONNECT ')), ping: __cotalBytes.equals(Buffer.from('PING\\r\\n')) }, this);"],
        ["    async _closed(err, internal = true) {", "    async _closed(err, internal = true) {\n        __cotalSdkWrite({ kind: 'sdk-close', code: __cotalSdkTag(err?.code), constructor: __cotalSdkTag(err?.constructor?.name), connected: this.connected, done: this.done, internal, bufferedFrames: this.yields.length }, this);"],
      ] : [
        ["        const err = ProtocolHandler.toError(s);", "        const err = ProtocolHandler.toError(s);\n        __cotalSdkWrite({ kind: 'sdk-error-parsed', authorization: err instanceof errors_1.errors.AuthorizationError, expired: err instanceof errors_1.errors.UserAuthenticationExpiredError, constructor: __cotalSdkTag(err?.constructor?.name) }, this.transport);"],
      ];
      changes.push(['"use strict";\n', '"use strict";\n' + prefix]);
      for (const [anchor, replacement] of changes) {
        if (source.split(anchor).length !== 2) throw new Error("pinned SDK diagnostic anchor is not unique");
        source = source.replace(anchor, replacement);
      }
      return { ...loaded, source, shortCircuit: true };
    }
    if (loaded.format !== "module") throw new Error("unexpected core probe module format");
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
