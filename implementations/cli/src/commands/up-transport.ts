import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { CONTRACT_ARTIFACT_MAX_BYTES, MANAGER_START_PAYLOAD_FLOOR, isReachable, DEFAULT_SERVER, validateTlsMaterial, type BrokerTransport } from "@cotal-ai/core";
import {
  CommandFailure,
  brokerAddressForDisplay,
  brokerPolicyPath,
  canonicalRoot,
  findMesh,
  parsePositiveIntegerFlag,
  retainedLegacyBroker,
  readBrokerPolicy,
  writeBrokerPolicy,
  recordsElsewhereError,
  shellPath,
  terminalWidth,
} from "@cotal-ai/workspace";
import { c, hang, stderrLine } from "../ui.js";
import { localDiagnostic } from "../telemetry.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { readStackJournal } from "../lib/stack-journal.js";
import { lastServedStore, lastServedStores, missingStoreWarning, servedStore, sharedStoreAtStart, sharedStoreWarning } from "../lib/store-dir.js";

export function parseMaxFileStore(raw: string | undefined): number | undefined {
  return parsePositiveIntegerFlag("--max-file-store", raw);
}

/** `--auth-timeout`, whole seconds from 1 to 60. nats-server warns above 60 that the value is
 *  probably a mistake, and a stalled callout holds every connect that long. */
export function parseAuthTimeout(raw: string | undefined): number | undefined {
  const seconds = parsePositiveIntegerFlag("--auth-timeout", raw);
  if (seconds !== undefined && seconds > MAX_AUTH_TIMEOUT_SECONDS)
    throw new CommandFailure("refused", "USAGE_INVALID", `--auth-timeout ${seconds} is over ${MAX_AUTH_TIMEOUT_SECONDS} seconds; it is how long the broker holds a connect while the auth callout has not answered, and nothing was started`, { remedy: `pass --auth-timeout 1 to ${MAX_AUTH_TIMEOUT_SECONDS}, or omit it for nats-server's 2 seconds` });
  return seconds;
}
const MAX_AUTH_TIMEOUT_SECONDS = 60;

/** `--max-payload`, a positive whole number of bytes. nats-server refuses to start above 64 MiB, so
 *  the refusal names that bound rather than letting the broker exit on its own configuration. */
export function parseMaxPayload(raw: string | undefined): number | undefined {
  const bytes = parsePositiveIntegerFlag("--max-payload", raw);
  if (bytes !== undefined && bytes > MAX_BROKER_PAYLOAD_BYTES)
    throw new CommandFailure("refused", "USAGE_INVALID", `--max-payload ${bytes} is over ${MAX_BROKER_PAYLOAD_BYTES} bytes (64 MiB), which nats-server refuses to start on; nothing was started`, { remedy: `pass --max-payload ${MAX_BROKER_PAYLOAD_BYTES} or less` });
  return bytes;
}
const MAX_BROKER_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** A manager publishes its contract artifacts before it can serve. */
export function assertManagerPayload(maxPayload: number | undefined): void {
  if (maxPayload !== undefined && maxPayload < MANAGER_START_PAYLOAD_FLOOR)
    throw new CommandFailure("refused", "USAGE_INVALID", `--max-payload ${maxPayload} is below ${MANAGER_START_PAYLOAD_FLOOR} bytes, the least the space's manager starts on: it publishes its contract artifacts, one message each, and the largest is bounded at ${CONTRACT_ARTIFACT_MAX_BYTES} bytes with ${MANAGER_START_PAYLOAD_FLOOR - CONTRACT_ARTIFACT_MAX_BYTES} more for the publish; nothing was started`, { remedy: `pass --max-payload ${MANAGER_START_PAYLOAD_FLOOR} or more, or pass --no-manager to start the broker without a manager` });
}

/** `--account-resolver`, memory or full. */
export function parseAccountResolver(raw: string | undefined): "memory" | "full" | undefined {
  if (raw === undefined || raw === "memory" || raw === "full") return raw;
  throw new CommandFailure("refused", "USAGE_INVALID", `--account-resolver takes memory or full (got ${JSON.stringify(raw)}); nothing was started`, { remedy: "pass --account-resolver memory or --account-resolver full" });
}

/** The auth-service daemon argv that gives the callout the broker's timeout as its deadline. Built
 *  only from the value the broker configuration rendered, so the two never differ. */
export function authTimeoutArgs(seconds: number | undefined): string[] {
  return seconds === undefined ? [] : ["--auth-timeout", String(seconds)];
}

/** Refuse `up --space` of a space this machine started from another folder while its broker answers,
 *  naming that folder: the stack there is the one to use or stop. */
export async function refuseRunningElsewhere(space: string, root: string): Promise<void> {
  const owner = findMesh(space);
  if (!owner || owner.origin === "manual" || owner.origin === "catalog" || !isAbsolute(owner.root) || canonicalRoot(owner.root) === canonicalRoot(root) || !(await isReachable(owner.server))) return;
  let controller = false;
  try { controller = readStackJournal(owner.root)?.journal.space === space; } catch { /* named with the legacy stop */ }
  const rootExists = existsSync(owner.root);
  const moved = !controller && !retainedLegacyBroker(owner.root) && recordsElsewhereError(root)?.details.stackSpace === space;
  const remedy = moved
    ? `${rootExists ? `move what is now at ${owner.root} aside, then ` : ""}move this folder back to ${owner.root} and run \`cotal down --yes\` there`
    : !rootExists
      ? `restore the original project at ${owner.root}, then run \`cotal down --yes\` there`
      : `use it from here with --space ${space}, or stop it with \`cotal down${controller ? " --yes" : ""}\` in ${owner.root}`;
  throw new CommandFailure("refused", "CONFLICT", `space "${space}" runs at ${owner.server}, started in ${owner.root}, so up did not start it again`, { target: { space, root: owner.root, server: owner.server }, remedy });
}

/** Refuses a bare `up` in a folder holding the records of a space this machine registers for another
 *  folder, as a copy, a moved folder and one whose name a later `up` took over keep them. The retained
 *  launcher writes no stack journal, so this is that launcher's form of the journal's refusal: it
 *  names that folder and the step reads there name. When that folder is gone and its broker does not
 *  answer, it also names the `--space` that takes the name over to run the stack from this folder. */
export async function refuseRecordsElsewhere(root: string): Promise<void> {
  const records = recordsElsewhereError(root)?.details;
  if (!records?.lastRun || records.stackSpace === undefined || records.recordedRoot === undefined || records.stackRemedy === undefined) return;
  const space = records.stackSpace;
  const takeover = !existsSync(records.recordedRoot) && !(await isReachable(findMesh(space)?.server ?? records.server ?? DEFAULT_SERVER));
  throw new CommandFailure("refused", "CONFLICT", `this folder holds the records of "${space}", which is registered for ${records.recordedRoot}, not for this folder, so up did not start it here`, {
    target: { root, space, recordedRoot: records.recordedRoot },
    remedy: takeover ? `${records.stackRemedy}; or, to run it from this folder, take the name over with \`cotal up --space ${space}\`` : records.stackRemedy,
  });
}

/**
 * Turn the `--tls-cert`/`--tls-key` pair into a validated {@link BrokerTransport}, or `plaintext`
 * when neither was given.
 *
 * REFUSES BEFORE LAUNCH, never after. Everything it rejects would otherwise become a running broker
 * in some wrong state, and the two failure modes are not symmetrical: a broker that will not start
 * is an operator reading an error, while a broker that starts wrong is an operator believing they
 * have TLS. So the validation is deliberately ours and deliberately early.
 *
 * `validateTlsMaterial` does the substantive checks — readability, private-key mode, PEM pair
 * match, validity window, dial-host SAN — because nats-server's are not sufficient. Missing,
 * unreadable and mismatched pairs do stop it before it opens a listener, but an EXPIRED certificate
 * does not: it reports the config valid, starts, logs "Server is ready" and "TLS required", and
 * only the client then fails. An expired cert must never yield "mesh up".
 *
 * @param dialHost the hostname clients will verify against, which is NOT the bind host — a broker
 *                 may bind `0.0.0.0` while clients dial `broker.example`.
 */
export function resolveTransport(
  values: { "tls-cert"?: string; "tls-key"?: string },
  dialHost: string | undefined,
  root: string,
  /** `persist` defaults false (commit-after-apply). `quiet` suppresses serving/inheriting lines
   *  until the caller announces after a successful apply. */
  opts: { persist?: boolean; quiet?: boolean } = {},
): BrokerTransport {
  const certFile = values["tls-cert"], keyFile = values["tls-key"];
  const quiet = opts.quiet === true;

  // NO FLAGS: inherit the RECORDED decision rather than defaulting to plaintext. This is the half
  // that makes a bare `cotal up` after a `cotal down` keep serving TLS. Without it the decision
  // lives only in the argv of whichever invocation first made it, and the most ordinary operator
  // gesture there is - stop the mesh, start it again - silently downgrades a broker that was
  // deliberately put on TLS. `readBrokerPolicy` refuses rather than degrading if the recorded
  // material has gone missing, so a moved cert fails loud here instead of coming up in cleartext.
  if (!certFile && !keyFile) {
    let recorded;
    try {
      recorded = readBrokerPolicy(root);
    } catch (e) {
      stderrLine("✗ ", `${e instanceof Error ? e.message : String(e)}`, c.red);
      process.exit(1);
    }
    if (recorded?.transport.kind === "tls-required") {
      if (!quiet) console.log(c.dim("TLS: inheriting the recorded broker policy (no --tls-cert/--tls-key given)"));
      return validateRecorded(recorded.transport, dialHost, { quiet });
    }
    return { kind: "plaintext" };
  }

  // Half a pair is a mistake, never a configuration. Refusing names the missing half rather than
  // failing later inside nats-server with a message about a file the operator did not mention.
  if (!certFile || !keyFile) {
    stderrLine("✗ ", `--tls-cert and --tls-key must be given together (missing ${certFile ? "--tls-key" : "--tls-cert"})`, c.red);
    process.exit(1);
  }

  const transport: BrokerTransport = { kind: "tls-required", certFile: resolve(certFile), keyFile: resolve(keyFile) };
  const validated = validateRecorded(transport, dialHost, { quiet });
  // RECORD only when the caller has already applied the transport (started a matching listener).
  // Eager write here is S5: a refuse path cannot unwrite, and the next bare up inherits fiction.
  if (opts.persist === true) writeBrokerPolicy(root, { version: 1, transport: validated });
  return validated;
}

/** A `tls://` broker address is recorded as required TLS, and every later dial through the record
 *  trusts it. Refuse it, before anything starts, when this start would serve plaintext. */
export function assertTlsIntentServed(server: string, transport: BrokerTransport, source: string): void {
  const tls = server.split(",").some((url) => url.trim().toLowerCase().startsWith("tls://"));
  if (tls && transport.kind !== "tls-required")
    throw new CommandFailure("refused", "USAGE_INVALID", `${source} names a tls:// address, but no TLS certificate and key are configured, so the broker would serve plaintext; nothing was started`, { target: { server: brokerAddressForDisplay(server) ?? "not displayable" }, remedy: "serve TLS with --tls-cert <cert.pem> --tls-key <key.pem>, or use a nats:// address", selfContained: true });
}

/** A broker that serves TLS is dialed `tls://`, so an address naming `nats://` would be recorded,
 *  registered and handed to every later client as plaintext. Refuse it before anything starts,
 *  naming the recorded policy that serves TLS and the address to pass instead. */
export function assertTlsAddressServed(server: string, transport: BrokerTransport, root: string): void {
  if (transport.kind !== "tls-required") return;
  if (!server.split(",").some((url) => /^nats:\/\//i.test(url.trim()))) return;
  throw new CommandFailure("refused", "USAGE_INVALID", `this root serves the broker over TLS (${brokerPolicyPath(root)}), so --server must be a tls:// address; nothing was started or written`, {
    target: { root, server: brokerAddressForDisplay(server) ?? "not displayable" },
    remedy: `pass --server ${tlsAddress(server)}`,
    selfContained: true,
  });
}

/** Persist a transport, and the auth callout timeout, payload limit and account resolver the broker
 *  configuration rendered, after its listener starts; a structured boot leaves stdout to its receipt.
 *  An absent `accountResolver` keeps the recorded one, and a memory start replaces a recorded full
 *  one even when nothing else is left to record. */
export function commitTransportPolicy(root: string, transport: BrokerTransport, quietBoot = false, server?: string, limits?: { authTimeout?: number; maxPayload?: number; accountResolver?: "memory" | "full" }): void {
  const { authTimeout, maxPayload } = limits ?? {};
  const recordedResolver = readBrokerPolicy(root)?.accountResolver;
  const full = (limits?.accountResolver ?? recordedResolver ?? "memory") === "full";
  if (transport.kind !== "tls-required" && authTimeout === undefined && maxPayload === undefined && !full && recordedResolver === undefined) return;
  writeBrokerPolicy(root, { version: 1, transport, ...(authTimeout !== undefined ? { authTimeout } : {}), ...(maxPayload !== undefined ? { maxPayload } : {}),
    ...(full ? { accountResolver: "full" as const } : {}) });
  if (!quietBoot) announceTransport(transport, server);
}

/** The `tls://` form of a broker URL, or of each URL in a list. */
export const tlsAddress = (server: string): string => server.split(",").map((url) => url.trim().replace(/^nats:/i, "tls:")).join(",");

export function announceTransport(transport: BrokerTransport, server?: string): void {
  if (transport.kind !== "tls-required") return;
  try {
    const material = validateTlsMaterial(transport, {});
    console.log(c.dim(`TLS: serving ${material.subject}${server ? ` at ${server}` : ""}, valid until ${material.notAfter.toISOString()}`));
  } catch {
    // Already validated at decide-time; announce is best-effort display.
  }
}

/** Read the live INFO greeting and report whether the listener requires TLS.
 *  `undefined` means no usable INFO (timeout / closed) — caller treats as unknown. */
export async function liveListenerRequiresTls(server: string, timeoutMs = 2000): Promise<boolean | undefined> {
  let host: string;
  let port: number;
  try {
    const u = new URL(server);
    host = u.hostname || "127.0.0.1";
    port = Number(u.port) || 4222;
  } catch {
    return undefined;
  }
  return await new Promise((res) => {
    const sock = createConnection({ host, port });
    let buf = "";
    const done = (v: boolean | undefined) => {
      try { sock.destroy(); } catch { /* */ }
      res(v);
    };
    sock.setTimeout(timeoutMs, () => done(undefined));
    sock.on("error", () => done(undefined));
    sock.on("close", () => done(undefined));
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const info = JSON.parse(line.replace(/^INFO\s+/, "")) as { tls_required?: boolean };
        done(info.tls_required === true);
      } catch {
        done(undefined);
      }
    });
  });
}

/**
 * Re-assert that `transport` is valid for the host clients will actually dial, and exit loudly if
 * not. A no-op for plaintext.
 *
 * This exists because the transport is decided ONCE, early, before the route is known, so that no
 * route can be reached without one — but the effective dial host is decided LATE and differs per
 * route: a manifest may set `broker.host`, and a certificate valid for the flag-derived host is not
 * thereby valid for that one. Deciding early and checking late is the only ordering that satisfies
 * both, so the check is deliberately separate from the decision rather than folded into it.
 *
 * Quiet on success: `resolveTransport` already printed what is being served, and a second identical
 * line reads like a second broker.
 */
export function assertServesDialHost(transport: BrokerTransport, dialHost: string | undefined): BrokerTransport {
  if (transport.kind !== "tls-required" || dialHost === undefined) return transport;
  try {
    validateTlsMaterial(transport, { dialHost });
  } catch (e) {
    stderrLine("✗ ", `${e instanceof Error ? e.message : String(e)}`, c.red);
    process.exit(1);
  }
  return transport;
}

/**
 * The client-side TLS requirement to persist for a listener THIS PROCESS DID NOT START — the
 * restore and ordinary-resume paths, which adopt a broker that is already listening.
 *
 * They have no `transport` in scope because they never decided one, so the honest source is the
 * recorded policy: the listener they are adopting was started from it. Reading it here is what stops
 * a resume from writing a registry entry that says "plaintext" over a broker serving TLS — clients
 * resolved from that entry would then connect without requiring it, which is the downgrade this
 * feature exists to prevent, arriving by way of a recovery path rather than a launch.
 *
 * Fails loud on an unusable policy for the same reason `resolveTransport` does: a resume that cannot
 * tell what it is adopting must not guess.
 */
export function adoptedTlsRequired(root: string): boolean {
  try {
    return readBrokerPolicy(root)?.transport.kind === "tls-required";
  } catch (e) {
    stderrLine("✗ ", `${e instanceof Error ? e.message : String(e)}`, c.red);
    process.exit(1);
  }
}

/** Validate a TLS pair and exit loudly on anything wrong. Shared by the flag path and the
 *  recorded-policy path so a cert that rots on disk is caught on the NEXT `up`, not only on the
 *  one that first configured it. */
function validateRecorded(
  transport: BrokerTransport,
  dialHost: string | undefined,
  opts: { quiet?: boolean } = {},
): BrokerTransport {
  try {
    const material = validateTlsMaterial(transport as Extract<BrokerTransport, { kind: "tls-required" }>, dialHost !== undefined ? { dialHost } : {});
    if (!opts.quiet) console.log(c.dim(`TLS: serving ${material.subject}, valid until ${material.notAfter.toISOString()}`));
  } catch (e) {
    // Surface the CERTIFICATE cause. A TLS failure reported as a generic startup error invites the
    // wrong remedy - operators go looking at ports and firewalls when the answer is the cert.
    stderrLine("✗ ", `${e instanceof Error ? e.message : String(e)}`, c.red);
    process.exit(1);
  }
  return transport;
}

/** A start that names no store would open an empty second store and leave the data where it was:
 *  while the last served store holds data and the default store holds none, refuse and name it. */
export function refuseUnnamedLastStore(storeDir: string): void {
  if (existsSync(join(storeDir, "jetstream"))) return;
  const last = lastServedStore(cotalRoot(), storeDir);
  if (last !== undefined)
    throw localDiagnostic(new CommandFailure("refused", "CONFLICT", `this root's last broker served the store ${last}, and this start names no store, so it would open a new empty one at ${storeDir}; nothing was started`, { target: { root: cotalRoot(), storeDir: last }, remedy: `reopen it with --store-dir ${shellPath(last)}, or move that store away to start empty` }));
}

/** The store a bare start that names none opens: the store this root's last broker served, while
 *  it holds data and the default store holds none, since the default would open empty and leave the
 *  data where it was. When the broker configs name two such stores, the start refuses as
 *  {@link refuseUnnamedLastStore} does, because which one to reopen is the operator's choice. */
export function reopenLastStore(storeDir: string): string | undefined {
  if (existsSync(join(storeDir, "jetstream"))) return undefined;
  const last = lastServedStores(cotalRoot(), storeDir);
  if (last.length > 1) refuseUnnamedLastStore(storeDir);
  if (last.length === 1) for (const line of hang("", `reopening ${last[0]}, the store this root's last broker served`, terminalWidth(process.stdout), c.dim)) console.log(line);
  return last[0];
}

/** A `--store-dir` that does not exist yet, while the last served store holds data, is taken for a
 *  mistyped path: the start would open a new empty store there. Creating the directory first names a
 *  new store on purpose. */
export function refuseMissingNamedStore(storeDir: string): void {
  if (existsSync(storeDir)) return;
  const last = lastServedStore(cotalRoot(), storeDir);
  if (last !== undefined)
    throw localDiagnostic(new CommandFailure("refused", "CONFLICT", `this root's last broker served the store ${last}, and --store-dir names ${storeDir}, which does not exist, so this start would open a new empty store there; nothing was started`, { target: { root: cotalRoot(), storeDir: last, requested: storeDir }, remedy: `reopen it with --store-dir ${shellPath(last)}, or create ${storeDir} first to start on a new empty store` }));
}

/** A start's store against the other spaces that use it. A `--store-dir` this root's last broker did
 *  not serve refuses while another space uses it. The default or last served store starts with a
 *  warning, and one whose folder that broker served is missing starts empty with a warning. */
export function checkStartStore(storeDir: string | undefined, space: string): void {
  const path = storeDir === undefined ? cotalPath("nats") : resolve(storeDir);
  const served = servedStore(cotalRoot(), path);
  const tenants = sharedStoreAtStart(path, space, storeDir === undefined || served);
  if (tenants.length) console.error(c.yellow(`! ${sharedStoreWarning(path, tenants)}`));
  if (served && !existsSync(path)) console.error(c.yellow(`! ${missingStoreWarning(path)}`));
}
