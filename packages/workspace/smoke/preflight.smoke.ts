/**
 * The preflight mechanics in `@cotal-ai/workspace` (`preflight.ts`), shared by the CLI's
 * `connectOrExit` and the manager's control commands. All broker-free:
 *
 *  • classifyPreflightFailure — the (source × reason × has-auth) decision tree. The load-bearing
 *    invariant: a NON-registry source (flag-server / local-space, or a raw `--creds`) is NEVER
 *    pruned — only the registry owns its entries, so a bad `--creds` can't delete a good record.
 *  • renderWorkspaceError — one canonical sentence per failure kind (unreachable names the recorded root).
 *  • preflightTarget — probe a DEAD port and assert it classifies unreachable + prunes by source,
 *    WITHOUT mutating the registry (it returns the decision; the caller mutates).
 *  • an inferred auth-required (an auth greeting, then a reset handshake) refuses but never deletes a
 *    record, while a real refusal behind the same greeting still drops an `up` record.
 *  • pruneStaleMeshes — a registered entry whose broker is gone is kept as offline; an explicit call only.
 *  • resolveControlTarget — a space-less control resolve sweeps once, and the sweep it reads is the
 *    one the caller handed in when there is one (#3872).
 *
 * Run: pnpm smoke:preflight
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MeshTarget, PreflightFailure } from "@cotal-ai/workspace"; // erased at runtime — safe before the COTAL_HOME sandbox

// Sandbox the registry BEFORE importing core — homeCotalDir() reads COTAL_HOME per call, so the
// real ~/.cotal is never touched by recordMesh/pruneStaleMeshes below.
const home = mkdtempSync(join(tmpdir(), "cotal-preflight-home-"));
process.env.COTAL_HOME = home;

const {
  classifyPreflightFailure,
  findMesh,
  MeshTargetError,
  preflightTarget,
  pruneMesh,
  pruneStaleMeshes,
  resolveMeshTarget,
  recordMesh,
  removeMesh,
  loadMeshes,
  meshFile,
  preflightOrThrow,
  renderWorkspaceError,
  reachableOrThrow,
  ConnectRefusal,
  resolveControlTarget,
  setCurrent,
  clearCurrent,
} = await import("@cotal-ai/workspace");

// The canonical preflight copy now comes from the renderer (workspace's optional, command-agnostic
// presentation helper); this shim keeps the message assertions below reading unchanged.
const preflightMessage = (kind: PreflightFailure, t: MeshTarget, pruned: boolean): string =>
  renderWorkspaceError({ kind: "preflight", failure: kind, target: t, pruned });

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};

// A closed loopback port — probeConnect refuses fast (no listener), so every probe below is "unreachable".
const DEAD = "nats://127.0.0.1:14991";
const REGISTRY = ["registry", "current", "flag-space", "local-recorded"] as const;
// `flag-space-override` (a `--space` whose `--server` overrides the recorded broker) is non-registry:
// the probe hits the operator's endpoint, so its failure must never prune the recorded entry (B1).
const NON_REGISTRY = ["flag-server", "local-space", "flag-space-override"] as const;

// ── classifyPreflightFailure: the decision tree ──────────────────────────────────────────────────
// unreachable: a registry-owned target prunes (broker gone); a non-registry one never does.
for (const s of REGISTRY)
  check(`unreachable + ${s} → prune + 'unreachable'`, (() => {
    const r = classifyPreflightFailure(s, "unreachable", true);
    return r.prune === true && r.kind === "unreachable";
  })());
for (const s of NON_REGISTRY)
  check(`unreachable + ${s} → NO prune + 'unreachable'`, (() => {
    const r = classifyPreflightFailure(s, "unreachable", false);
    return r.prune === false && r.kind === "unreachable";
  })());
check("auth-required + registry + has-auth → prune + 'registry-creds-rejected'", (() => {
  const r = classifyPreflightFailure("flag-space", "auth-required", true);
  return r.prune === true && r.kind === "registry-creds-rejected";
})());
check("auth-required + registry + open → prune + 'registry-open-now-auth'", (() => {
  const r = classifyPreflightFailure("registry", "auth-required", false);
  return r.prune === true && r.kind === "registry-open-now-auth";
})());
check("auth-required + local + has-auth → NO prune + 'creds-rejected'", (() => {
  const r = classifyPreflightFailure("local-space", "auth-required", true);
  return r.prune === false && r.kind === "creds-rejected";
})());
check("auth-required + local + open → NO prune + 'open-wants-auth'", (() => {
  const r = classifyPreflightFailure("flag-server", "auth-required", false);
  return r.prune === false && r.kind === "open-wants-auth";
})());
// INFERRED auth-required (an auth greeting, then a reset handshake): no refusal was read, so it
// names the same failure as a real refusal but never prunes, whatever the source.
for (const s of REGISTRY)
  for (const hasAuth of [true, false])
    check(`inferred auth-required + ${s} / auth=${hasAuth} → NO prune + '${hasAuth ? "registry-creds-rejected" : "registry-open-now-auth"}'`, (() => {
      const r = classifyPreflightFailure(s, "auth-required", hasAuth, true);
      return r.prune === false && r.kind === (hasAuth ? "registry-creds-rejected" : "registry-open-now-auth");
    })());
// STALE-AUTH (D5 slice 6): a dead CREDENTIAL on a LIVE broker — never a prune, whatever the
// source (deleting a live mesh's entry for an expired cred would misdirect the repair).
for (const s of [...REGISTRY, ...NON_REGISTRY])
  for (const hasAuth of [true, false])
    check(`stale-auth + ${s} / auth=${hasAuth} → NO prune + 'stale-auth'`, (() => {
      const r = classifyPreflightFailure(s, "stale-auth", hasAuth);
      return r.prune === false && r.kind === "stale-auth";
    })());
// …and the canonical copy names the ONE repair surface, not a re-registration.
check("stale-auth preflight copy names `cotal doctor auth` (the repair surface)", (() => {
  const t = { space: "team", server: "nats://127.0.0.1:14990", root: "/tmp/p", source: "registry", mode: "auth" } as never;
  const msg = renderWorkspaceError({ kind: "preflight", failure: "stale-auth", target: t, pruned: false });
  return msg.includes("doctor auth") && msg.includes("EXPIRED");
})());
// TIMEOUT (#851 cell c): a probe that ran out of its own budget is never a stale-entry signal,
// whatever the source — a slow or jittery link is not a dead broker.
for (const s of [...REGISTRY, ...NON_REGISTRY])
  check(`timeout + ${s} → NO prune + 'slow-link'`, (() => {
    const r = classifyPreflightFailure(s, "timeout", true);
    return r.prune === false && r.kind === "slow-link";
  })());
check("stale-auth raw-probe copy names `cotal doctor auth`", (() => {
  const msg = renderWorkspaceError({ kind: "reachable", reason: "stale-auth", server: "nats://x:1", hasAuth: true });
  return msg.includes("doctor auth") && msg.includes("EXPIRED");
})());
// TLS-TRUST: live TLS-required NATS listener, failed TLS handshake (private CA / missing CA).
// Copy must name the repair, admit INFO is unauthenticated (not identity), and MUST NOT claim removal.
check("tls-trust preflight copy names NODE_EXTRA_CA_CERTS, NATS listener, unauthenticated INFO, conservatively kept", (() => {
  const t = { space: "team", server: "nats://127.0.0.1:14990", root: "/tmp/p", source: "registry", mode: "auth", tlsRequired: true } as never;
  const msg = renderWorkspaceError({ kind: "preflight", failure: "tls-trust", target: t, pruned: false });
  return msg.includes("NODE_EXTRA_CA_CERTS")
    && msg.includes("TLS-required NATS listener")
    && msg.includes("unauthenticated")
    && msg.includes("conservatively kept")
    && !msg.includes("removed");
})());

// `auth-required` on the RAW probe splits the same way the registry path splits it. Both cells are
// load-bearing in one direction each: collapsing them back tells a caller who sent nothing that its
// credentials were refused, and the reverse tells a caller holding a bad cred to go get one.
const rawAuthRequired = (hasAuth: boolean) =>
  renderWorkspaceError({ kind: "reachable", reason: "auth-required", server: "nats://x:1", hasAuth });
check("raw auth-required WITH creds says they were rejected", (() => {
  const msg = rawAuthRequired(true);
  return msg.includes("credentials rejected") && !msg.includes("no credentials were supplied");
})());
check("raw auth-required WITHOUT creds says none were supplied, and does not claim rejection", (() => {
  const msg = rawAuthRequired(false);
  return msg.includes("no credentials were supplied") && msg.includes("--creds") && !msg.includes("credentials rejected");
})());
check("the two raw auth-required sentences actually differ", rawAuthRequired(true) !== rawAuthRequired(false));

// The invariant, exhaustively: a non-registry source is NEVER pruned — whatever the reason/auth.
for (const s of NON_REGISTRY)
  for (const reason of ["unreachable", "auth-required", "stale-auth"] as const)
    for (const hasAuth of [true, false])
      check(
        `non-registry ${s} / ${reason} / auth=${hasAuth} never prunes`,
        classifyPreflightFailure(s, reason, hasAuth).prune === false,
      );

// ── preflightMessage: one canonical sentence per kind, surface-agnostic (plain text, no colour) ───
const T: MeshTarget = {
  root: "/tmp/proj",
  server: DEAD,
  space: "alpha",
  personaRoot: "/tmp/proj/.cotal/agents",
  source: "registry",
  mode: "open",
  tlsRequired: false,
};
check("message: unreachable keeps `no mesh running at` and names the recorded root", (() => {
  const m = preflightMessage("unreachable", T, false);
  return m.includes(`no mesh running at ${DEAD}`) && m.includes(`mesh "${T.space}" is recorded at ${T.root}`) && m.includes("cotal up") && m.includes("there to restart") && !m.includes("removed");
})(), preflightMessage("unreachable", T, false));
check("message: unreachable + pruned still names the recorded root (liveness no longer deletes)",
  preflightMessage("unreachable", T, true).includes(`recorded at ${T.root}`) && preflightMessage("unreachable", T, true).includes(`no mesh running at ${DEAD}`) && !preflightMessage("unreachable", T, true).includes("stale registry entry - removed"));
check("message: prune flag does not change the unreachable sentence (record is kept)", preflightMessage("unreachable", T, true) === preflightMessage("unreachable", T, false));
for (const kind of ["registry-creds-rejected", "registry-open-now-auth", "creds-rejected", "open-wants-auth"] as const)
  check(`message: ${kind} names the server + leads with ✗`, (() => {
    const m = preflightMessage(kind, T, true);
    return m.includes(DEAD) && m.startsWith("✗");
  })());
// The space-named kinds carry the mesh name; open-wants-auth is about a nameless open broker, so it
// names the server only — assert the distinction rather than blur it.
for (const kind of ["registry-creds-rejected", "registry-open-now-auth", "creds-rejected"] as const)
  check(`message: ${kind} also names the space`, preflightMessage(kind, T, true).includes("alpha"));
check("message: open-wants-auth does NOT claim a space name", !preflightMessage("open-wants-auth", T, true).includes("alpha"));

// ── preflightTarget: probe a dead broker, classify, but DO NOT mutate the registry ────────────────
recordMesh({ space: "probe-victim", server: DEAD, root: "/tmp/proj", mode: "open", ts: new Date(0).toISOString() });
const reg: MeshTarget = { ...T, space: "probe-victim", source: "registry" };
const rReg = await preflightTarget(reg);
check("preflightTarget(dead, registry) → not-ok, unreachable, prune", !rReg.ok && rReg.kind === "unreachable" && rReg.prune === true, rReg);
check("preflightTarget did NOT itself prune (caller owns the mutation)", loadMeshes().some((m) => m.space === "probe-victim"), loadMeshes());
const rFlag = await preflightTarget({ ...T, space: "probe-victim", source: "flag-server" });
check("preflightTarget(dead, flag-server) → not-ok, unreachable, NO prune", !rFlag.ok && rFlag.kind === "unreachable" && rFlag.prune === false, rFlag);

// ── B1: `--space` + a `--server` that OVERRIDES the recorded broker. The probe hits the operator's
//    endpoint, so resolveMeshTarget marks it `flag-space-override` and a failure must NOT prune the
//    recorded entry — a dead override can't delete a live registered mesh, and pre-prune can't block
//    a live-override recovery. ──────────────────────────────────────────────────────────────────────
recordMesh({ space: "team-ov", server: "nats://127.0.0.1:14993", root: "/tmp/proj", mode: "open", ts: new Date(0).toISOString() });
check("resolveMeshTarget: --space + overriding --server → source 'flag-space-override' + override server", (() => {
  const t = resolveMeshTarget("/nonexistent/cwd", { space: "team-ov", server: "nats://127.0.0.1:19998" });
  return t.source === "flag-space-override" && t.server === "nats://127.0.0.1:19998";
})());
check("resolveMeshTarget: --space + --server EQUAL to recorded → still 'flag-space' (registry-owned)",
  resolveMeshTarget("/nonexistent/cwd", { space: "team-ov", server: "nats://127.0.0.1:14993" }).source === "flag-space");
check("resolveMeshTarget: --space without --server → 'flag-space'",
  resolveMeshTarget("/nonexistent/cwd", { space: "team-ov" }).source === "flag-space");
// The decisive B1 assertion: a dead OVERRIDE endpoint classifies no-prune, so the wrapper never
// removes the recorded entry — and the entry is indeed still there afterward.
const ovDead = await preflightTarget({ ...T, space: "team-ov", source: "flag-space-override" });
check("preflightTarget(dead override) → not-ok, NO prune (recorded entry is safe)", !ovDead.ok && ovDead.prune === false, ovDead);
check("team-ov registry entry survives the override preflight", loadMeshes().some((m) => m.space === "team-ov"), loadMeshes());

// ── pruneStaleMeshes: an explicit sweep keeps dead entries as offline ────────────────────────────
// Isolate this cell: earlier probes left other dead records, and they stay too.
for (const m of loadMeshes()) removeMesh(m.space);
recordMesh({ space: "ghost-2", server: "nats://127.0.0.1:14992", root: "/tmp/p2", mode: "open", ts: new Date(0).toISOString() });
await pruneStaleMeshes();
check("pruneStaleMeshes keeps every dead entry as offline", loadMeshes().length === 1 && loadMeshes()[0]!.space === "ghost-2", loadMeshes());

// ── ORIGIN: a liveness prune never deletes; a mismatch prune still drops `up` ────────────────────
// REVERSAL of the previous design (test-locked at preflight.smoke.ts:206-212): an `up` record whose
// broker is dead used to be deleted, a `manual` one kept. Redness of those old assertions is
// expected and intended. Mismatch (creds / mode / stale-auth-root) still deletes `up`.
const DEAD_2 = "nats://127.0.0.1:14989";
recordMesh({ space: "ours", server: DEAD_2, root: "/tmp/p3", mode: "open", origin: "up", ts: new Date(0).toISOString() });
recordMesh({ space: "theirs", server: DEAD_2, root: "/tmp/p3", mode: "open", origin: "manual", ts: new Date(0).toISOString() });
const sweep = await pruneStaleMeshes();
check("sweep KEEPS the `up` record", findMesh("ours") !== undefined, loadMeshes());
check("sweep KEEPS the operator-registered record", findMesh("theirs") !== undefined, loadMeshes());
check("sweep reports both as offline (none pruned)", sweep.pruned.length === 0 && sweep.offline.includes("ours") && sweep.offline.includes("theirs"), sweep);
assert.throws(() => resolveMeshTarget("/nonexistent/cwd", { offline: sweep.offline }), /no mesh running/);
check("all-offline is still no-meshes; both records remain", findMesh("ours") !== undefined && findMesh("theirs") !== undefined);
check("pruneMesh reports refusing to delete a manual record", pruneMesh("theirs") === false && findMesh("theirs") !== undefined);
check("pruneMesh reports refusing to delete an `up` record on liveness", pruneMesh("ours") === false && findMesh("ours") !== undefined);
check("pruneMesh reports nothing removed for an absent record", pruneMesh("never-recorded") === false);
check("pruneMesh mismatch still drops an `up` record", pruneMesh("ours", "mismatch") === true && findMesh("ours") === undefined);
check("pruneMesh mismatch still refuses a manual record", pruneMesh("theirs", "mismatch") === false && findMesh("theirs") !== undefined);
// …and the copy stops telling the operator to `cotal up` a mesh that runs somewhere else.
const manualT = { ...T, space: "theirs", origin: "manual" as const };
check("unreachable copy for a registered mesh names `cotal meshes rm`, not `cotal up`", (() => {
  const m = preflightMessage("unreachable", manualT, false);
  return m.includes("cotal meshes rm theirs") && !m.includes("cotal up");
})(), preflightMessage("unreachable", manualT, false));
check("stale-auth-root copy claims a removal only when one happened", (() => {
  const kept = renderWorkspaceError({ kind: "target", error: new MeshTargetError("stale-auth-root", "x", { space: "theirs", root: "/tmp/p3", found: "other", removed: false }) });
  const gone = renderWorkspaceError({ kind: "target", error: new MeshTargetError("stale-auth-root", "x", { space: "ours", root: "/tmp/p3", found: "other", removed: true }) });
  return !kept.includes("removed") && kept.includes("cotal meshes add") && gone.includes("stale entry removed");
})());

// ── INFERRED auth: a reset after an auth greeting names the failure but never deletes a record ───
// A listener that greets like an auth broker and resets the handshake gives the client what Windows
// gives it when the reset discards the broker's `-ERR`. The control greets the same way, reads the
// whole handshake, refuses with the real `-ERR` and closes cleanly. That refusal still drops its
// `up` record, which is what shows these cells can see a deletion.
{
  const { createServer } = await import("node:net");
  const listen = (onConnect: (sock: import("node:net").Socket) => void) =>
    new Promise<{ server: string; close: () => Promise<void> }>((resolve) => {
      const srv = createServer((sock) => {
        sock.on("error", () => { /* the probe tears its own sockets down */ });
        sock.write('INFO {"server_id":"inferred","version":"2.12.12","proto":1,"max_payload":1048576,"auth_required":true}\r\n');
        onConnect(sock);
      });
      srv.listen(0, "127.0.0.1", () =>
        resolve({ server: `nats://127.0.0.1:${(srv.address() as { port: number }).port}`, close: () => new Promise((r) => srv.close(() => r())) }));
    });
  const reset = await listen((sock) => sock.once("data", () => sock.resetAndDestroy()));
  const refuse = await listen((sock) => {
    let seen = "";
    sock.on("data", (chunk: Buffer) => {
      seen += chunk.toString("utf8");
      if (seen.includes("PING\r\n")) sock.end("-ERR 'Authorization Violation'\r\n");
    });
  });
  for (const [space, server] of [["inferred-auth", reset.server], ["refused-auth", refuse.server]] as const)
    recordMesh({ space, server, root: `/tmp/${space}`, mode: "open", origin: "up", ts: new Date(0).toISOString() });
  const inferredT: MeshTarget = { ...T, space: "inferred-auth", server: reset.server, root: "/tmp/inferred-auth", origin: "up" };
  const classified = await preflightTarget(inferredT);
  check("an inferred auth-required classifies registry-open-now-auth with NO prune", !classified.ok && classified.kind === "registry-open-now-auth" && classified.prune === false, classified);
  const before = readFileSync(meshFile("inferred-auth"));
  const inferredRefusal = await preflightOrThrow(inferredT).then(() => undefined, (e: unknown) => e);
  check("preflightOrThrow refuses the command on it as AUTH_REQUIRED", inferredRefusal instanceof ConnectRefusal && inferredRefusal.code === "AUTH_REQUIRED", String(inferredRefusal));
  check("…and the `up` record's registry bytes survive unchanged", Buffer.compare(before, readFileSync(meshFile("inferred-auth"))) === 0);
  const refusedT: MeshTarget = { ...T, space: "refused-auth", server: refuse.server, root: "/tmp/refused-auth", origin: "up" };
  const refused = await preflightOrThrow(refusedT).then(() => undefined, (e: unknown) => e);
  check("CONTROL: a real auth refusal behind the same greeting is AUTH_REQUIRED and drops the `up` record", refused instanceof ConnectRefusal && refused.code === "AUTH_REQUIRED" && findMesh("refused-auth") === undefined, { refused: String(refused), meshes: loadMeshes() });
  await reset.close();
  await refuse.close();
}

// ── S10 delayed-INFO confirm: first 1s INFO read misses; second longer read must still save. ─────
// A TCP peer that greets with INFO {tls_required:true} only after 1.5s and then answers the TLS
// client hello with a non-TLS byte string, so the handshake fails CONCLUSIVELY (a protocol error,
// not a timeout). probeConnect → unreachable; without the confirm budget on the INFO read this
// would prune. A peer that never answers the hello is a pure timeout, which #851 routes to
// slow-link before INFO is consulted at all (S11 below); this peer must not be that shape.
{
  const { createServer } = await import("node:net");
  const delayed = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const srv = createServer((sock) => {
      sock.on("error", () => { /* client tears down on its own error; not a test failure */ });
      setTimeout(() => {
        try {
          sock.write('INFO {"server_id":"s10","tls_required":true,"version":"2"}\r\n');
        } catch { /* client gone */ }
      }, 1_500);
      sock.once("data", () => {
        try { sock.write("-ERR not a tls record\r\n"); } catch { /* client gone */ }
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ port, close: () => srv.close() });
    });
  });
  const slowServer = `nats://127.0.0.1:${delayed.port}`;
  recordMesh({
    space: "s10-slow",
    server: slowServer,
    root: "/tmp/s10-slow",
    mode: "open",
    tlsRequired: true,
    origin: "up",
    ts: new Date(0).toISOString(),
  });
  const slowT: MeshTarget = {
    ...T,
    space: "s10-slow",
    server: slowServer,
    root: "/tmp/s10-slow",
    mode: "open",
    tlsRequired: true,
    source: "registry",
    origin: "up",
  };
  const t0 = Date.now();
  const slowR = await preflightTarget(slowT);
  const elapsed = Date.now() - t0;
  check(
    "S10 delayed-INFO: preflightTarget → tls-trust, prune:false (confirm path, not 1s miss)",
    !slowR.ok && slowR.kind === "tls-trust" && slowR.prune === false,
    slowR,
  );
  check(
    "S10 delayed-INFO: took >1s (second confirm read engaged)",
    elapsed >= 1_400,
    { elapsed },
  );
  check(
    "S10 delayed-INFO: registry entry still present (caller would not prune)",
    loadMeshes().some((m) => m.space === "s10-slow"),
    loadMeshes(),
  );
  delayed.close();
}

// ── S11 held-open TLS peer (#851 cell a): accepts TCP, greets INFO {tls_required:true}, then never
// answers the TLS client hello. This is the issue's exact shape — the earlier collapse to
// `unreachable` made the classifier re-read the same INFO and misreport `tls-trust` (a CA hint) for
// a pure timeout. The fix must discriminate the timeout and never consult INFO for it. ──────────
{
  const { createServer } = await import("node:net");
  const held = await new Promise<{ port: number; close: () => void }>((resolve) => {
    const srv = createServer((sock) => {
      sock.on("error", () => { /* client resets when its own probe budget expires; not a test failure */ });
      sock.write('INFO {"server_id":"s11","tls_required":true,"version":"2"}\r\n');
      // Hold the socket open; never answer the TLS client hello, never close.
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ port, close: () => srv.close() });
    });
  });
  const heldServer = `nats://127.0.0.1:${held.port}`;
  recordMesh({
    space: "s11-held",
    server: heldServer,
    root: "/tmp/s11-held",
    mode: "open",
    tlsRequired: true,
    origin: "up",
    ts: new Date(0).toISOString(),
  });
  const heldT: MeshTarget = {
    ...T,
    space: "s11-held",
    server: heldServer,
    root: "/tmp/s11-held",
    mode: "open",
    tlsRequired: true,
    source: "registry",
    origin: "up",
  };
  const heldR = await preflightTarget(heldT);
  check(
    "S11 held-open TLS peer: preflightTarget → slow-link, prune:false (#851 cell a)",
    !heldR.ok && heldR.kind === "slow-link" && heldR.prune === false,
    heldR,
  );
  check(
    "S11 held-open TLS peer: registry entry still present (#851 cell a)",
    loadMeshes().some((m) => m.space === "s11-held"),
    loadMeshes(),
  );
  check(
    "S11 held-open TLS peer: rendered sentence names no CA (#851 cell d)",
    (() => {
      const msg = preflightMessage("slow-link", heldT, false);
      return !/CA|certificate|trust/i.test(msg) && msg.includes("registry entry was kept");
    })(),
    preflightMessage("slow-link", heldT, false),
  );
  held.close();
}

// ── S12 raw off-registry preflight (#709): reachableOrThrow re-probes at the confirm budget ────────
// before condemning a slow-but-live broker, and the timeout sentence names a budget actually spent.
{
  const { createServer } = await import("node:net");
  const slowRawSrv = createServer((sock) => {
    sock.on("error", () => { /* client tears down on its own error; not a test failure */ });
    setTimeout(() => {
      try {
        sock.write('INFO {"server_id":"s12","version":"2.12.0","proto":1,"headers":true,"max_payload":1048576}\r\n');
      } catch { /* client gone */ }
    }, 1_500);
    sock.on("data", (chunk: Buffer) => {
      if (chunk.includes("PING")) {
        try { sock.write("PONG\r\n"); } catch { /* client gone */ }
      }
    });
  });
  const slowRawPort = await new Promise<number>((resolve) => {
    slowRawSrv.listen(0, "127.0.0.1", () => resolve((slowRawSrv.address() as { port: number }).port));
  });
  const slowRaw = `nats://127.0.0.1:${slowRawPort}`;

  const t12a0 = Date.now();
  let s12aOk = false;
  try {
    await reachableOrThrow(slowRaw, {});
    s12aOk = true;
  } catch { /* checked below */ }
  const s12aElapsed = Date.now() - t12a0;
  check(
    "S12 delayed-INFO plain peer: reachableOrThrow resolves through the confirm probe (#709)",
    s12aOk,
  );
  check(
    "S12 delayed-INFO plain peer: took >1s (the confirm probe engaged, #709)",
    s12aElapsed >= 1_400,
    { s12aElapsed },
  );
  slowRawSrv.close();

  const heldRawSrv = createServer((sock) => {
    sock.on("error", () => { /* client resets when its own probe budget expires; not a test failure */ });
    // Accept TCP; never write, never close.
  });
  const heldRawPort = await new Promise<number>((resolve) => {
    heldRawSrv.listen(0, "127.0.0.1", () => resolve((heldRawSrv.address() as { port: number }).port));
  });
  const heldRaw = `nats://127.0.0.1:${heldRawPort}`;

  const t12b0 = Date.now();
  let s12bMsg: string | undefined;
  try {
    await reachableOrThrow(heldRaw, {});
  } catch (e) {
    s12bMsg = e instanceof ConnectRefusal ? e.message : undefined;
  }
  const s12bElapsed = Date.now() - t12b0;
  check(
    "S12 held-open plain peer: a peer that took the connection and never greets is not answering, not \"is it running\" (the gate still requires the greeting on a socket it owns, #2156)",
    s12bMsg !== undefined && s12bMsg.includes("is not answering") && s12bMsg.includes("did not complete within") && !s12bMsg.includes("is it running"),
    s12bMsg,
  );
  check(
    "S12 held-open plain peer: elapsed at least 8s (the confirm budget was spent inside the gate, #709)",
    s12bElapsed >= 8_000,
    { s12bElapsed },
  );
  heldRawSrv.close();

  const t12c0 = Date.now();
  let s12cMsg: string | undefined;
  try {
    await reachableOrThrow(DEAD, {});
  } catch (e) {
    s12cMsg = e instanceof ConnectRefusal ? e.message : undefined;
  }
  const s12cElapsed = Date.now() - t12c0;
  check(
    "S12 dead port: the raw refusal still says is-it-running and spends no confirm budget (#709)",
    s12cMsg !== undefined && s12cMsg.includes("is it running"),
    s12cMsg,
  );
  check(
    "S12 dead port: elapsed under 2s (#709)",
    s12cElapsed < 2_000,
    { s12cElapsed },
  );
}

// ── One sweep per control resolve (#3872) ────────────────────────────────────────────────────────
// `beta` is a bystander that only a registry sweep dials, so its dial count is the sweep count. The
// mode peek and the connect read one sweep, a named `--space` reads none, and a sweep the caller
// already took is the verdict the whole chain reads. The cwd is `/` so the walk-up can never select
// a real project once `current` is skipped.
{
  const { createServer } = await import("node:net");
  const greeter = () => new Promise<{ server: string; dials: () => number; close: () => void }>((resolve) => {
    let dials = 0;
    const srv = createServer((sock) => {
      dials++;
      sock.on("error", () => { /* client tears down after its probe; not a test failure */ });
      sock.write('INFO {"server_id":"s3872","version":"2.10.0","proto":1,"headers":true,"max_payload":1048576}\r\n');
      sock.on("data", (d) => {
        if (d.toString().includes("PING")) sock.write("PONG\r\n");
      });
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      resolve({ server: `nats://127.0.0.1:${port}`, dials: () => dials, close: () => srv.close() });
    });
  });
  const alpha = await greeter();
  const beta = await greeter();
  for (const m of loadMeshes()) removeMesh(m.space);
  for (const [space, peer] of [["alpha", alpha], ["beta", beta]] as const)
    recordMesh({ space, server: peer.server, root: `/tmp/s3872-${space}`, mode: "open", origin: "manual", ts: new Date(0).toISOString() });
  setCurrent("alpha");
  const cwd = process.cwd();
  process.chdir("/");
  const control = (flags: { space?: string; offline?: string[] }) =>
    resolveControlTarget(flags, "control-caller-privileged", undefined, { onRefusal: "throw" });

  let before = beta.dials();
  const spaceless = await control({});
  check(
    "a space-less control resolve sweeps the registry once: its mode peek and its connect read one sweep (#3872)",
    spaceless.space === "alpha" && beta.dials() - before === 1,
    { space: spaceless.space, sweeps: beta.dials() - before },
  );
  before = beta.dials();
  const named = await control({ space: "alpha" });
  check(
    "a named --space control resolve sweeps nothing",
    named.space === "alpha" && beta.dials() - before === 0,
    { space: named.space, sweeps: beta.dials() - before },
  );
  // A selected space stays the target while its broker is down, so the handed-in sweep is read with
  // nothing selected.
  clearCurrent();
  before = alpha.dials();
  const handed = await control({ offline: ["alpha"] });
  check(
    "a control resolve reads the sweep its caller handed in: the mesh it marks offline is skipped and never dialed",
    handed.space === "beta" && alpha.dials() - before === 0,
    { space: handed.space, alphaDials: alpha.dials() - before },
  );
  process.chdir(cwd);
  alpha.close();
  beta.close();
}

rmSync(home, { recursive: true, force: true });
console.log(`\npreflight (workspace) smoke: ${pass} checks passed`);
process.exit(0);
