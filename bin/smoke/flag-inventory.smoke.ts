/**
 * Flag-inventory parity smoke: the GOLDEN inventory of every command's accepted flags,
 * captured from main at the kernel migration (2026-07), asserted against the declared specs.
 * Any future flag add/remove/retype must edit this file consciously — the silent-change
 * vector (parseArgs strictness drift across hand-rolled parsers) is gone.
 *
 * Deliberate deltas from main, reviewed with the migration (see PR):
 *  - commands whose positionals were accepted-but-ignored now reject them
 *    (setup/go/up/down/join/console);
 *  - manager commands accepted the UNION of all manager flags; each now accepts exactly its own
 *    (e.g. `stop --model` was accepted-and-ignored, now a usage error); the dead `--drive` flag
 *    is gone;
 *  - `feedback` keeps its own dual-mode parsing (rawArgs) until the intake server splits out.
 *
 * Run: pnpm smoke:flag-inventory
 */
import assert from "node:assert/strict";
import { registry, type Command } from "@cotal-ai/core";
import "@cotal-ai/cli"; // registers the base CLI commands
import "@cotal-ai/manager"; // registers supervise/start/stop/ps/attach
import "@cotal-ai/delivery"; // registers deliver
import "@cotal-ai/auth"; // registers login/logout

/** flag spec inventory as "name:type" (+ ":short" when aliased), sorted. */
const TARGET = ["creds:string", "server:string", "space:string"];
const GOLDEN: Record<string, { flags: string[]; positionals: boolean; rawArgs?: boolean }> = {
  // Stage 2b: setup is configure-only — --open's home is `cotal up` (where it already lived);
  // --auth simply died with the launch behavior. `go` (a pure alias of setup) is deleted outright.
  setup: { flags: ["demo:boolean", "full:boolean", "yes:boolean:y"], positionals: false },
  update: { flags: ["self:boolean"], positionals: false },
  up: {
    flags: [
      "channels:string", "detach:boolean", "dry-run:boolean", "file:string:f", "host:string",
      "idp:string", "open:boolean", "runtime:string", "server:string", "space:string",
      "restore:string", "restore-only:string", "accept-missing-source:boolean",
      "store-dir:string", "user-auth:boolean",
    ],
    positionals: false,
  },
  // `--space` (2026-07): selects the mesh for target-addressed components (`cotal down web --space <name>`).
  down: { flags: ["dry-run:boolean", "file:string:f", "preserve-state:boolean", "run:string", "space:string", "store-dir:string"], positionals: true },
  backup: { flags: ["only:string", "store-dir:string"], positionals: true },
  meshes: { flags: [], positionals: false },
  status: { flags: ["server:string", "space:string"], positionals: false },
  doctor: { flags: ["fix:boolean", "space:string"], positionals: true },
  use: { flags: [], positionals: true },
  join: {
    flags: [
      ...TARGET, "channel:string", "kind:string", "lifecycle-uid:string", "link:string",
      "name:string", "role:string", "tls:boolean", "token:string",
    ],
    positionals: false,
  },
  send: { flags: [...TARGET], positionals: true },
  endpoints: { flags: [...TARGET], positionals: false },
  console: { flags: [...TARGET, "plain:boolean"], positionals: false },
  // web moved out to the @cotal-ai/web extension package (stage 4)
  // Stage 2a: spawn absorbs the detached mode — the full launch grammar (launchFlags) + --detach,
  // and gains --model/--cwd (parity) + --creds (control-caller, --detach only, guarded in run).
  spawn: {
    flags: [
      "agent:string", "allow-publish:string", "allow-stale:string", "allow-subscribe:string",
      "config:string", "creds:string", "cwd:string", "detach:boolean:d", "dry-run:boolean",
      "file:string:f", "live-only:boolean", "model:string", "name:string", "no-transcript:boolean",
      "opt:string", "prompt:string", "resume:string", "role:string", "runtime:string",
      "server:string", "share-tools:string", "space:string", "subscribe:string",
      "transcript:boolean", "variant:string",
    ],
    positionals: true,
  },
  models: { flags: [...TARGET, "agent:string", "refresh:boolean"], positionals: false },
  personas: {
    flags: [
      ...TARGET, "force:boolean", "from:string", "model:string", "prompt:string", "role:string",
      "running:boolean", "verbose:boolean:v",
    ],
    positionals: true,
  },
  completion: { flags: [], positionals: true },
  ext: { flags: ["force:boolean", "repair:boolean", "reset:boolean"], positionals: true },
  __complete: { flags: [], positionals: true, rawArgs: true },
  mint: {
    flags: ["allow-publish:string", "allow-subscribe:string", "force:boolean", "out:string", "profile:string", "signer:boolean"],
    positionals: true,
  },
  topology: { flags: ["file:string:f"], positionals: true },
  channels: {
    flags: [...TARGET, "desc:string", "instructions:string", "no-replay:boolean", "replay:boolean", "window:string"],
    positionals: true,
  },
  history: { flags: [...TARGET, "dms:boolean", "force:boolean"], positionals: true },
  // The unified cleanup verb: `history clear`'s grammar + the local-state targets' --store-dir.
  clean: { flags: [...TARGET, "attempt:string", "dms:boolean", "force:boolean", "store-dir:string"], positionals: true },
  // Stage 2b: feedback is the CLIENT only (declared flags, real help); the --keys intake server
  // moved to implementations/delivery as `feedback-intake`.
  feedback: {
    flags: [
      "area:string", "details:string", "email:string", "key:string", "name:string",
      "severity:string", "type:string", "url:string",
    ],
    positionals: true,
  },
  supervise: {
    flags: ["console-host:string", "console-port:string", "launch:string", "resume-attempt:string", "resume-commit-token:string", "roster:string", "runtime:string", "server:string", "space:string", "spawn:string"],
    positionals: false,
  },
  // Read-only listing of the manager's spawn backends (pty + installed/known runtime providers).
  runtimes: { flags: [], positionals: false },
  // Stage 2a: `start` is a tombstone — errors naming `spawn --detach`; never a silent alias.
  start: { flags: [], positionals: true, rawArgs: true },
  stop: { flags: [...TARGET, "name:string"], positionals: false },
  ps: { flags: [...TARGET], positionals: false },
  attach: { flags: [...TARGET, "name:string"], positionals: false },
  deliver: {
    flags: ["creds:string", "dev-mint:boolean", "server:string", "shard:string", "shards:string", "space:string"],
    positionals: false,
  },
  "feedback-intake": {
    flags: [
      "channel:string", "creds:string", "host:string", "keys:string", "max-bytes:string",
      "port:string", "rate-limit:string", "server:string", "space:string", "store:string",
    ],
    positionals: false,
  },
  login: { flags: ["client-id:string", "idp:string"], positionals: false },
  logout: { flags: ["idp:string"], positionals: false },
  // Per-user auth (D4c): the actor-ledger operator surface + the auth-service daemon.
  actor: {
    flags: [
      "allow-publish:string", "allow-subscribe:string", "label:string", "owner:string",
      "parent:string", "role:string", "scope:string", "space:string", "sub:string",
    ],
    positionals: true,
  },
  "auth-service": { flags: ["port:string", "server:string", "space:string"], positionals: false },
  // Gate 1 (user-mode agent launch): the machine-facing bearer refresh a spawned agent execs.
  "agent-bearer": {
    flags: ["actor:string", "dir:string", "health-file:string", "owner:string", "space:string", "token-file:string"],
    positionals: false,
  },
};

const commands = registry.all<Command>("command");
const names = commands.map((c) => c.name).sort();
assert.deepEqual(names, Object.keys(GOLDEN).sort(), "command set matches the golden inventory");

for (const cmd of commands) {
  const golden = GOLDEN[cmd.name];
  const declared = (cmd.flags ?? [])
    .map((f) => `${f.name}:${f.type}${f.short ? `:${f.short}` : ""}`)
    .sort();
  assert.deepEqual(declared, [...golden.flags].sort(), `flags of \`${cmd.name}\` match golden`);
  assert.equal(cmd.positionals !== undefined, golden.positionals, `positionals gate of \`${cmd.name}\``);
  assert.equal(Boolean(cmd.rawArgs), Boolean(golden.rawArgs), `rawArgs of \`${cmd.name}\``);
  // Every declared flag is parseable metadata: string flags carry a metavar or default help.
  for (const f of cmd.flags ?? []) {
    assert.ok(f.name && (f.type === "string" || f.type === "boolean"), `flag spec sane on ${cmd.name} --${f.name}`);
  }
}

console.log(`✓ flag-inventory smoke passed (${commands.length} commands)`);
