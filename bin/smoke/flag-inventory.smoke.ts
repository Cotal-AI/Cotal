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
      // The optional PUBLIC remote-exchange face, threaded to the auth-service daemon.
      // `--advertised-server` (2026-08): with --exchange-public-port, the broker address the public
      // discovery bundle advertises - what participants dial, which is not the address the callout
      // dials (--server is loopback/LAN and meaningless off the machine).
      "advertised-server:string",
      // `--agent-provisioning-url` (2026-08): the U6 remote agent-provisioning endpoint the public
      // bundle advertises, threaded to the auth-service daemon like --advertised-server.
      "agent-provisioning-url:string",
      "exchange-public-port:string", "exchange-public-url:string", "exchange-trusted-proxy:boolean",
      "restore:string", "restore-only:string", "accept-missing-source:boolean",
      // `--rotate-sys` (2026-08): the class-3 renewal, which rotates the system account and re-mints the
      // two $SYS creds, which nothing re-signs in place (issue #338).
      "rotate-sys:boolean",
      "store-dir:string", "tls-cert:string", "tls-key:string", "user-auth:boolean",
    ],
    positionals: false,
  },
  // `--space` (2026-07): selects the mesh for target-addressed components (`cotal down web --space <name>`).
  down: { flags: ["dry-run:boolean", "file:string:f", "preserve-state:boolean", "run:string", "space:string", "store-dir:string"], positionals: true },
  backup: { flags: ["only:string", "store-dir:string"], positionals: true },
  // `meshes` gained the registry-maintenance verbs (2026-08): `add <space> --server … [--root]
  // [--mode]` registers a mesh this machine did NOT start, `rm <space> …` drops records. `--force`
  // is add's unverified/replace escape and rm's running-mesh override. Bare `meshes` still lists.
  // `--allow-unencrypted-overlay` (2026-08): registering an overlay address is refused unless the
  // operator accepts, explicitly, that it is protected only while the tunnel is up. A printed
  // warning was not a fence (stderr is unread by scripts, and it was not persisted).
  // Remote registration (2026-08): `--tls` records enforced TLS intent (a tls:// --server implies
  // it), and `--mode user` registers from supplied pinned trust via `--user-auth-file` or `--from`.
  meshes: { flags: ["allow-unencrypted-overlay:boolean", "force:boolean", "from:string", "mode:string", "root:string", "server:string", "tls:boolean", "user-auth-file:string"], positionals: true },
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
  // The generic v0.4 service surface (P2 item 1, 1c.2b): describe an endpoint's registered
  // command set off the wire; invoke one command by name with JSON args.
  describe: { flags: [...TARGET], positionals: true },
  invoke: {
    flags: [...TARGET, "admin:boolean", "args:string", "name:string", "self:boolean", "timeout:string"],
    positionals: true,
  },
  console: { flags: [...TARGET, "plain:boolean"], positionals: false },
  // web moved out to the @cotal-ai/web extension package (stage 4)
  // Stage 2a: spawn absorbs the detached mode — the full launch grammar (launchFlags) + --detach,
  // and gains --model/--cwd (parity) + --creds (control-caller, --detach only, guarded in run).
  spawn: {
    flags: [
      "agent:string", "allow-publish:string", "allow-stale:string", "allow-subscribe:string",
      "config:string", "creds:string", "cwd:string", "detach:boolean:d", "dry-run:boolean",
      "events:boolean", "file:string:f", "live-only:boolean", "model:string", "name:string", "no-events:boolean",
      "on:string", "opt:string", "prompt:string", "resume:string", "role:string", "runtime:string",
      "server:string", "share-tools:string", "space:string", "subscribe:string", "variant:string",
    ],
    positionals: true,
  },
  models: { flags: [...TARGET, "agent:string", "refresh:boolean"], positionals: false },
  personas: {
    flags: [
      ...TARGET, "force:boolean", "from:string", "model:string", "prompt:string", "role:string",
      "running:boolean", "verbose:boolean:v",
      // `--subscribe` (2026-08, 53f66c25): `personas new` requires the persona to name the channels
      // it reads ("" = none), so the flag it is passed through must be declared here too.
      "subscribe:string",
    ],
    positionals: true,
  },
  completion: { flags: [], positionals: true },
  ext: { flags: ["force:boolean", "repair:boolean", "reset:boolean"], positionals: true },
  __complete: { flags: [], positionals: true, rawArgs: true },
  mint: {
    // `--role` / `--provision` / `--space` / `--server` (2026-08): an out-of-band mint can pre-create
    // the identity's bind-only durables so the credential can CONSUME, not only publish (issue #306's
    // second half); the target flags name the mesh that provisioning connects to.
    flags: [
      "allow-publish:string", "allow-subscribe:string", "force:boolean", "out:string", "profile:string",
      "provision:boolean", "role:string", "server:string", "signer:boolean", "space:string",
    ],
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
    flags: ["console-host:string", "console-port:string", "launch:string", "resume-attempt:string", "resume-commit-token:string", "roster:string", "runtime:string", "server:string", "space:string", "spawn:string", "ws-port:string"],
    positionals: false,
  },
  // The guarded exit from an issuance gate left frozen by a crashed manager restart (#391). It is
  // a CLI command rather than a manager admin verb because the state it repairs IS "the manager
  // cannot complete registration" — an endpoint-served repair would be unreachable exactly when it
  // is needed. No `--force`: the only way it reopens a gate is by proving the holder is gone.
  "reconcile-gate": {
    flags: ["endpoint:string", "instance:string", "server:string", "space:string"],
    positionals: false,
  },
  // The guarded exit for a REGISTRATION whose host is gone (SPEC 13.5: a deleted `svc` spec is the
  // deregistration). Its sibling above repairs a frozen gate; this removes a record that nothing in
  // the model expires, and it is a local operator command for the same reason: the instance it is
  // about answers nothing, so there is no endpoint to serve the repair. Same four flags, because
  // both name one instance of one endpoint on one mesh. No `--force`: the record goes only when the
  // broker affirms nothing is subscribed on that instance's own rail.
  "deregister-instance": {
    flags: ["endpoint:string", "instance:string", "server:string", "space:string"],
    positionals: false,
  },
  // Read-only listing of the manager's spawn backends (pty + installed/known runtime providers).
  runtimes: { flags: [], positionals: false },
  // Stage 2a: `start` is a tombstone — errors naming `spawn --detach`; never a silent alias.
  start: { flags: [], positionals: true, rawArgs: true },
  stop: { flags: [...TARGET, "name:string", "on:string"], positionals: false },
  // #651: `--wide` (human facts line) / `--json` (machine rows) enrich the SAME listing; bare
  // output is unchanged. Mutually exclusive by construction, refused rather than prioritized.
  ps: { flags: [...TARGET, "on:string", "wide:boolean", "json:boolean"], positionals: false },
  // `--no-reconnect` (2026-08, lane A1): attach re-establishes its session when the LINK dies,
  // so the flag is the opt OUT, for scripts that want one session and one exit code. Named
  // `no-reconnect` rather than a negation of a `reconnect` flag for the reason `input` gives
  // just below: parseArgs does not negate under strict.
  attach: { flags: [...TARGET, "name:string", "no-reconnect:boolean", "on:string"], positionals: false },
  // `input` (2026-08, lane C3): type one line into a seat without attaching. `--text` is a VALUE
  // flag on purpose, so a payload that starts with `/` or `-` (a harness command such as
  // `/compact`) is taken verbatim instead of being parsed as an option; `--no-enter` is a declared
  // boolean rather than a negation of `--enter`, because parseArgs does not negate under strict.
  input: { flags: [...TARGET, "name:string", "no-enter:boolean", "on:string", "text:string"], positionals: false },
  deliver: {
    // `--tls` here is the daemon REQUIRING TLS to the broker, not offering it. Note that `join`
    // has carried a `tls:boolean` in this same inventory all along: the CLIENT half of TLS shipped
    // long ago and the SERVER half did not, which is this whole feature in one line.
    flags: ["creds:string", "dev-mint:boolean", "server:string", "shard:string", "shards:string", "space:string", "tls:boolean"],
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
  "auth-service": {
    flags: [
      // `--advertised-server` (2026-08): rides the public bundle, so it is threaded from `up` to
      // this daemon and must appear in both inventories.
      "advertised-server:string",
      // `--agent-provisioning-url` (2026-08): threaded from `up` like --advertised-server; both
      // inventories carry it.
      "agent-provisioning-url:string",
      "exchange-public-port:string", "exchange-public-url:string", "exchange-trusted-proxy:boolean",
      "port:string", "server:string", "space:string",
    ],
    positionals: false,
  },
  // Gate 1 (user-mode agent launch): the machine-facing bearer refresh a spawned agent execs.
  "agent-bearer": {
    flags: ["actor:string", "dir:string", "exchange-url:string", "health-file:string", "owner:string", "space:string", "token-file:string"],
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
