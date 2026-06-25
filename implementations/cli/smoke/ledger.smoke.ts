/**
 * Ownership-ledger smoke (hermetic — no broker): the `spawn -f` / `down -f` durable record and its
 * untrusted-input contract. Proves writeLedger is private + atomic + exclusive, loadLedger validates
 * the WHOLE ledger before a caller could delete anything (schema, traversal, concreteness, dups),
 * cred paths are DERIVED from the known auth root (never stored), findLedgerByHash fails-not-guesses,
 * and the core no-follow delete helpers refuse symlinks. Run with: pnpm smoke:ledger
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEDGER_VERSION,
  writeLedger,
  loadLedger,
  findLedgerByHash,
  findLedgerByRun,
  listLedgers,
  ownedCredPath,
  hashManifestSource,
  type MeshLedger,
} from "../src/lib/manifest/ledger.js";
import { realDirNoSymlink, unlinkFileNoFollow } from "@cotal-ai/core";

let failures = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  console.log(`${cond ? "✓" : "✗"} ${label}${cond ? "" : ` — ${extra ?? ""}`}`);
  if (!cond) failures++;
}
function throws(label: string, fn: () => unknown): void {
  try {
    fn();
    check(label, false, "did not throw");
  } catch {
    check(label, true);
  }
}

const ledgerOf = (over: Partial<MeshLedger> = {}): MeshLedger => ({
  apiVersion: LEDGER_VERSION,
  kind: "MeshLedger",
  runId: "run01",
  space: "demo",
  server: "nats://127.0.0.1:4222",
  manifestHash: "abc123",
  manifestPath: "/work/cotal.yaml",
  teardownMode: "ledger-scoped",
  created: { channels: ["general", "review"], agents: [{ requested: "scout", name: "scout", id: "UABC", hash: "deadbeef" }] },
  ...over,
});

// --- write: private + exclusive + round-trip --------------------------------------------------
const root = mkdtempSync(join(tmpdir(), "cotal-ledger-"));
{
  const path = writeLedger(root, ledgerOf());
  check("ledger lives under .cotal/manifests/<runId>.json", path.endsWith(join(".cotal", "manifests", "run01.json")));
  check("ledger is 0600", (statSync(path).mode & 0o777) === 0o600, (statSync(path).mode & 0o777).toString(8));
  const back = loadLedger(path);
  check("round-trips", back.runId === "run01" && back.created.agents[0].id === "UABC" && back.created.channels.length === 2);
  throws("exclusive create — a second write of the same runId is refused", () => writeLedger(root, ledgerOf()));
  // Atomic additive update (re-apply) replaces it via temp-then-rename.
  const p2 = writeLedger(root, ledgerOf({ created: { channels: ["general"], agents: [{ requested: "scout", name: "scout-2", id: "UDEF", hash: "feed01" }] } }), { update: true });
  check("update replaces atomically", loadLedger(p2).created.agents[0].name === "scout-2");
}

// --- load: untrusted-input validation ----------------------------------------------------------
function writeRaw(name: string, body: unknown): string {
  const p = join(root, name);
  writeFileSync(p, JSON.stringify(body));
  return p;
}
{
  check("valid ledger loads", loadLedger(writeRaw("ok.json", ledgerOf())).space === "demo");
  throws("bad apiVersion rejected", () => loadLedger(writeRaw("v.json", ledgerOf({ apiVersion: "nope" as never }))));
  throws("bad kind rejected", () => loadLedger(writeRaw("k.json", ledgerOf({ kind: "Evil" as never }))));
  throws("unknown top-level key rejected (strict)", () => loadLedger(writeRaw("u.json", { ...(ledgerOf() as object), bogus: 1 })));
  throws("path-traversal runId rejected", () => loadLedger(writeRaw("r.json", ledgerOf({ runId: "../evil" }))));
  throws("unsafe owned agent name rejected", () =>
    loadLedger(writeRaw("n.json", ledgerOf({ created: { channels: [], agents: [{ requested: "ok", name: "../x", id: "U1", hash: "h" }] } }))));
  throws("unsafe requested name rejected", () =>
    loadLedger(writeRaw("rq.json", ledgerOf({ created: { channels: [], agents: [{ requested: "../x", name: "ok", id: "U1", hash: "h" }] } }))));
  throws("non-alphanumeric hash rejected", () =>
    loadLedger(writeRaw("h.json", ledgerOf({ created: { channels: [], agents: [{ requested: "a", name: "a", id: "U1", hash: "../../etc" }] } }))));
  throws("wildcard owned channel rejected (concrete-only)", () =>
    loadLedger(writeRaw("w.json", ledgerOf({ created: { channels: ["team.>"], agents: [] } }))));
  throws("duplicate owned agent rejected", () =>
    loadLedger(writeRaw("da.json", ledgerOf({ created: { channels: [], agents: [{ requested: "a", name: "a", id: "U1", hash: "h" }, { requested: "a", name: "a", id: "U2", hash: "h" }] } }))));
  throws("duplicate owned channel rejected", () =>
    loadLedger(writeRaw("dc.json", ledgerOf({ created: { channels: ["general", "general"], agents: [] } }))));
}

// --- cred path is DERIVED from the known auth root, never stored --------------------------------
{
  const p = ownedCredPath(root, "scout-2");
  check("cred path under <root>/.cotal/auth/creds", p === join(root, ".cotal", "auth", "creds", "scout-2.creds"), p);
  throws("traversal spawned name refused", () => ownedCredPath(root, "../../etc/x"));
}

// --- findLedgerByHash / findLedgerByRun: fail-not-guess -----------------------------------------
{
  const r2 = mkdtempSync(join(tmpdir(), "cotal-ledger-find-"));
  writeLedger(r2, ledgerOf({ runId: "aaa", manifestHash: "h1" }));
  check("findLedgerByHash single match", findLedgerByHash(r2, "h1").ledger.runId === "aaa");
  throws("findLedgerByHash no match throws (edited file)", () => findLedgerByHash(r2, "nomatch"));
  writeLedger(r2, ledgerOf({ runId: "bbb", manifestHash: "h1" })); // second run, same hash ⇒ ambiguous
  throws("findLedgerByHash ambiguous throws (>1 run)", () => findLedgerByHash(r2, "h1"));
  check("findLedgerByRun resolves a known run", findLedgerByRun(r2, "aaa").ledger.runId === "aaa");
  throws("findLedgerByRun rejects a traversal run id", () => findLedgerByRun(r2, "../x"));
  // Filename ↔ runId binding: a `bar.json` whose body declares runId "foo" must not redirect teardown.
  mkdirSync(join(r2, ".cotal", "manifests"), { recursive: true });
  writeFileSync(join(r2, ".cotal", "manifests", "spoof.json"), JSON.stringify(ledgerOf({ runId: "elsewhere" })));
  throws("findLedgerByRun rejects a filename/runId mismatch (no spoofed authority)", () => findLedgerByRun(r2, "spoof"));
  check("listLedgers skips a filename/runId mismatch", !listLedgers(r2).some((l) => l.path.endsWith("spoof.json")));
  check("hashManifestSource is stable + hex", /^[a-f0-9]+$/.test(hashManifestSource("space: demo\n")) && hashManifestSource("x") === hashManifestSource("x"));
}

// --- core no-follow delete helpers --------------------------------------------------------------
{
  const r3 = mkdtempSync(join(tmpdir(), "cotal-nofollow-"));
  const file = join(r3, "a.creds");
  writeFileSync(file, "x");
  check("unlinkFileNoFollow removes a regular file", unlinkFileNoFollow(file) === true && !existsSync(file));
  check("unlinkFileNoFollow returns false for a missing file", unlinkFileNoFollow(join(r3, "gone")) === false);
  const ext = mkdtempSync(join(tmpdir(), "cotal-nofollow-ext-"));
  const extFile = join(ext, "secret");
  writeFileSync(extFile, "do not delete");
  const link = join(r3, "link.creds");
  symlinkSync(extFile, link);
  throws("unlinkFileNoFollow refuses a symlink", () => unlinkFileNoFollow(link));
  check("symlink target survives the refusal", existsSync(extFile));

  // realDirNoSymlink: real dir → path; absent component → null; symlinked component → throw.
  mkdirSync(join(r3, ".cotal", "run", "run01"), { recursive: true });
  check("realDirNoSymlink returns a real dir path", realDirNoSymlink(r3, ".cotal", "run", "run01") === join(r3, ".cotal", "run", "run01"));
  check("realDirNoSymlink returns null for an absent component", realDirNoSymlink(r3, ".cotal", "run", "nope") === null);
  const r4 = mkdtempSync(join(tmpdir(), "cotal-nofollow-sym-"));
  mkdirSync(join(r4, ".cotal"));
  symlinkSync(ext, join(r4, ".cotal", "run"));
  throws("realDirNoSymlink refuses a symlinked component", () => realDirNoSymlink(r4, ".cotal", "run", "run01"));
}

// --- ledger reads are no-follow (destructive-path contract) -------------------------------------
{
  // A symlinked ledger FILE is refused by loadLedger.
  const r5 = mkdtempSync(join(tmpdir(), "cotal-ledger-symfile-"));
  const real = writeLedger(r5, ledgerOf({ runId: "real01" }));
  const linkPath = join(r5, ".cotal", "manifests", "link01.json");
  symlinkSync(real, linkPath);
  throws("loadLedger refuses a symlinked ledger file", () => loadLedger(linkPath));

  // A symlinked .cotal/manifests parent is refused: listLedgers returns [], findLedgerByRun throws.
  const r6 = mkdtempSync(join(tmpdir(), "cotal-ledger-symdir-"));
  const ext = mkdtempSync(join(tmpdir(), "cotal-ledger-symdir-ext-"));
  mkdirSync(join(r6, ".cotal"));
  symlinkSync(ext, join(r6, ".cotal", "manifests"));
  throws("listLedgers refuses a symlinked .cotal/manifests (fail-closed)", () => listLedgers(r6));
  throws("findLedgerByRun refuses a symlinked .cotal/manifests", () => findLedgerByRun(r6, "anything"));
}

console.log(`\nLEDGER SMOKE ${failures === 0 ? "OK ✅" : "FAILED ❌"}`);
process.exit(failures === 0 ? 0 : 1);
