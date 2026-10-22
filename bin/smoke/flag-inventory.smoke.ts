/**
 * Flag-inventory parity smoke: the GOLDEN inventory of every command's accepted flags, asserted
 * against the declared specs. Any flag add/remove/retype must edit this file consciously; the
 * silent-change vector (parseArgs strictness drift across hand-rolled parsers) is gone.
 *
 * GOLDEN is the redesigned CLI surface as the cut registers it, including the hidden daemon twins
 * and the manager service child's roster input. It is checked by hand against the design, never
 * generated from the registry, and grouped so each entry's reason is visible:
 *  - canonical commands, with the flags the design gives them;
 *  - hidden entries the design keeps: the four deprecated daemon entries on their pre-cut parsers,
 *    the twins `up` launches without the deprecation warning, the machine-facing entries and the
 *    internal service and setup children;
 *  - migration tombstones, which keep their old flags so an old command line reaches the printed
 *    replacement instead of a parse error;
 *  - legacy spellings the redesign replaces that still register at this cut. Each one leaves
 *    GOLDEN in the change that removes or tombstones it.
 *
 * Deliberate deltas from main at the kernel migration (2026-07), reviewed then:
 *  - commands whose positionals were accepted-but-ignored now reject them
 *    (setup/go/up/down/join/console);
 *  - manager commands accepted the UNION of all manager flags; each now accepts exactly its own
 *    (e.g. `stop --model` was accepted-and-ignored, now a usage error); the dead `--drive` flag
 *    is gone.
 *
 * Run: pnpm smoke:flag-inventory
 */
import nodeAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { registry, type Command } from "@cotal-ai/core";
import { GLOBAL_FLAGS } from "@cotal-ai/workspace";
import "@cotal-ai/cli"; // registers the base CLI commands
import "@cotal-ai/manager"; // registers supervise/start/stop/ps/attach
import "@cotal-ai/delivery"; // registers deliver
import "@cotal-ai/auth"; // registers login/logout
import "@cotal-ai/runtime"; // registers run
import "../docs.js"; // registers docs, which the composition root adds

/** flag spec inventory as "name:type" (+ ":short" when aliased), sorted. */
const TARGET = ["creds:string", "server:string", "space:string:s"];
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;
const GOLDEN: Record<string, { flags: string[]; positionals: boolean; rawArgs?: boolean }> = {
  // ---- Canonical commands -------------------------------------------------------------------
  // Stage 2b: setup is configure-only; --open's home is `cotal up`, and `go` (a pure alias of setup)
  // is deleted outright. S2.3b/S2.3c (2026-10-16): setup takes its destination, application,
  // runtimes, project and space as flags. `--start`/`--detach` start the prepared space only on
  // explicit request, and `--on` pins the manager instance a self-hosted start launches through.
  setup: { flags: ["configure-only:boolean", "connection-file:string", "demo:boolean", "destination:string", "detach:boolean:d", "full:boolean", "harness:string:H", "json:boolean:j", "on:string", "plain:boolean", "project:string", "runtime:string", "skills:boolean", "space:string:s", "start:boolean", "yes:boolean:y"], positionals: false },
  // `--space`/`--server`/`--creds` (2026-09): after disk reconciliation, `update` reports the
  // selected running manager's custody generation. `--check` reads without changing anything.
  update: { flags: [...TARGET, "check:boolean", "json:boolean:j", "plain:boolean", "self:boolean"], positionals: false },
  // The command kernel's local entries (2026-10): `help [command…] [--all]` and `version`.
  help: { flags: ["all:boolean"], positionals: true },
  version: { flags: ["json:boolean:j"], positionals: false },
  completion: { flags: ["json:boolean:j", "plain:boolean"], positionals: true },
  // `config` (2026-10): personal preferences, read through or written to your defaults or one space;
  // `--verbose` also shows the shadowed values.
  config: { flags: ["json:boolean:j", "plain:boolean", "space:string:s", "user:boolean", "verbose:boolean:v"], positionals: true },
  // `--json` and `--plain` (2026-10): bare `ext` / `ext list` write one envelope or a plain report; the other subcommands refuse both.
  ext: { flags: ["force:boolean", "json:boolean:j", "plain:boolean", "repair:boolean", "reset:boolean"], positionals: true },
  // `docs` (2026-10): this version's bundled docs, registered by the composition root.
  docs: { flags: ["json:boolean:j", "plain:boolean", "refresh:boolean", "search:string"], positionals: true },
  up: {
    flags: [
      "channels:string", "detach:boolean", "dry-run:boolean", "file:string:f", "host:string",
      "idp:string", "max-sessions:string", "open:boolean", "runtime:string", "server:string", "space:string",
      // `up` starts in the background by default; `--foreground` keeps the stack in this terminal
      // and `--root` names the prepared project.
      "foreground:boolean", "root:string", "json:boolean:j", "plain:boolean",
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
      // `--accept-stale-checkpoint` (2026-09): gate 3's only override on the preserved-resume path.
      "accept-stale-checkpoint:boolean",
      // `--rotate-sys` (2026-08): the class-3 renewal, which rotates the system account and re-mints the
      // two $SYS creds, which nothing re-signs in place (issue #338).
      "rotate-sys:boolean",
      // `--max-file-store` (2026-09): the broker's JetStream file storage cap, fixed at start (#1888).
      "max-file-store:string",
      // `--no-manager` (2026-09): broker-only boot, the broker and in auth mode the delivery daemon (#1856).
      "no-manager:boolean",
      "store-dir:string", "tls-cert:string", "tls-key:string", "user-auth:boolean",
    ],
    positionals: false,
  },
  // Named owned services or the recorded whole stack. `--instance` qualifies one name, `--yes` and
  // `--dry-run` confirm or preview the reviewed scope. `--session-store` (2026-09) is the repeatable
  // harness transcript store a preserve-state cut captures. `--file`/`--run` are the historical
  // `spawn -f` teardown, which the redesign moves to `team remove <deployment-id>`.
  down: { flags: ["dry-run:boolean", "file:string:f", "instance:string", "json:boolean:j", "plain:boolean", "preserve-state:boolean", "run:string", "session-store:string", "space:string:s", "store-dir:string", "with-agents:boolean", "yes:boolean:y"], positionals: true },
  backup: { flags: ["accept-missing-source:boolean", "dry-run:boolean", "json:boolean:j", "only:string", "plain:boolean", "store-dir:string", "yes:boolean:y"], positionals: true },
  reset: { flags: ["dry-run:boolean", "json:boolean:j", "plain:boolean", "yes:boolean:y"], positionals: true },
  // `space` (2026-10): the registered spaces and one in full, on the structured output contract.
  // `space add` (2026-10) registers a space that runs elsewhere, from `--server` or a user-auth bundle;
  // `space delete` previews with `--dry-run`.
  space: { flags: ["allow-unencrypted-overlay:boolean", "dry-run:boolean", "file:string:f", "force:boolean", "from:string", "json:boolean:j", "mode:string", "plain:boolean", "root:string", "server:string", "tls:boolean", "yes:boolean:y"], positionals: true },
  // `sync` (2026-09): refresh the signed-in space catalogs; `--idp` narrows the refresh to one account.
  // `--json` and `--plain` (2026-10): the refresh on the structured output contract.
  sync: { flags: ["idp:string", "json:boolean:j", "plain:boolean"], positionals: false },
  // `--json` and `--plain` (2026-10): `use` reports or changes the selection on the structured output contract.
  use: { flags: ["json:boolean:j", "plain:boolean"], positionals: true },
  // Bare status is the infrastructure inventory; `status <agent> [--on]` inspects one incarnation.
  // `--components` (2026-08) is the historical health pass the bare service inventory replaces.
  status: { flags: ["all:boolean", "components:boolean", "creds:string", "json:boolean:j", "on:string", "plain:boolean", "server:string", "space:string:s", "verbose:boolean:v"], positionals: true },
  doctor: { flags: ["fix:boolean", "json:boolean:j", "plain:boolean", "space:string"], positionals: true },
  // `who` and `whoami` (2026-10): the roster and the CLI's own identity, on the structured output contract.
  who: { flags: [...TARGET, "all:boolean", "waiting:boolean", "json:boolean:j", "plain:boolean"], positionals: false },
  whoami: { flags: ["space:string:s", "server:string", "json:boolean:j", "plain:boolean"], positionals: false },
  // Stage 2a: spawn absorbs the detached mode: the full launch grammar (launchFlags) + --detach,
  // and gains --model/--cwd (parity) + --creds (control-caller, --detach only, guarded in run).
  // The shared short forms are -n/-m/-C/-p/-H. `--harness` picks the application, `--foreground`
  // runs it directly, `--restarts`/`--restart-window` ask the manager to supervise the seat, and
  // `--enrollment-file` redeems a one-time enrollment for that seat. `--config`, `--agent` and
  // `--expect-owner`/`--expect-lifecycle-uid` (2026-10, #2420) are the delegated launch contract
  // version 0 an older manager writes. `--allow-stale`/`--runtime` refuse and name `team deploy`.
  spawn: {
    flags: [
      "agent:string", "allow-publish:string", "allow-stale:string", "allow-subscribe:string",
      "config:string", "creds:string", "cwd:string:C", "detach:boolean:d", "dry-run:boolean",
      "enrollment-file:string", "events:boolean", "expect-lifecycle-uid:string", "expect-owner:string",
      "file:string:f", "foreground:boolean", "harness:string:H", "json:boolean:j", "live-only:boolean",
      "model:string:m", "name:string:n", "no-events:boolean", "on:string", "opt:string", "plain:boolean",
      "prompt:string:p", "restart-window:string", "restarts:string", "resume:string", "role:string",
      "runtime:string", "server:string", "share-tools:string", "space:string:s", "subscribe:string",
      "variant:string",
    ],
    positionals: true,
  },
  // #651: `--wide` (human facts line) / `--json` (machine rows) enrich the SAME listing; bare
  // output is unchanged. Mutually exclusive by construction, refused rather than prioritized.
  ps: { flags: [...TARGET, "on:string", "wide:boolean", "json:boolean:j", "plain:boolean", "slots:boolean"], positionals: false },
  // `--no-reconnect` (2026-08): attach re-establishes its session when the LINK dies,
  // so the flag is the opt OUT, for scripts that want one session and one exit code. Named
  // `no-reconnect` rather than a negation of a `reconnect` flag for the reason `input` gives
  // just below: parseArgs does not negate under strict. The agent may be named positionally.
  attach: { flags: [...TARGET, "name:string", "no-reconnect:boolean", "on:string"], positionals: true },
  // `stop <agent>`; `--self` stops the calling seat from its own shell and `--force` asks for the
  // hard despawn.
  stop: { flags: [...TARGET, "force:boolean", "json:boolean:j", "name:string", "on:string", "plain:boolean", "self:boolean"], positionals: true },
  // `input` (2026-08): type one line into a seat without attaching. `--text` is a VALUE
  // flag on purpose, so a payload that starts with `/` or `-` (a harness command such as
  // `/compact`) is taken verbatim instead of being parsed as an option; `--no-enter` is a declared
  // boolean rather than a negation of `--enter`, because parseArgs does not negate under strict.
  input: { flags: [...TARGET, "json:boolean:j", "name:string", "no-enter:boolean", "on:string", "plain:boolean", "text:string"], positionals: true },
  models: { flags: [...TARGET, "harness:string:H", "on:string", "refresh:boolean", "json:boolean:j", "plain:boolean"], positionals: false },
  // Read-only listing of the manager's spawn backends (pty + installed/known runtime providers).
  runtimes: { flags: ["json:boolean:j", "plain:boolean"], positionals: false },
  // Local definitions, or an exact manager's catalog with `--on`; `--announce` posts after a remote save.
  persona: {
    flags: [
      "allow-publish:string", "allow-subscribe:string", "announce:string", "file:string:f", "from:string",
      "harness:string:H", "json:boolean:j", "model:string:m", "on:string", "plain:boolean", "prompt:string:p",
      "role:string", "server:string", "space:string:s", "subscribe:string", "yes:boolean:y",
    ],
    positionals: true,
  },
  team: { flags: ["allow-stale:string", "dry-run:boolean", "foreground:boolean", "graph:boolean", "json:boolean:j", "plain:boolean", "runtime:string", "space:string:s", "yes:boolean:y"], positionals: true },
  // One message to one explicit destination: -t/-c/-r, a body positionally or from -f/--stdin,
  // repeatable `--mention` and `--reply-to` with `--to`.
  send: {
    flags: [
      ...TARGET, "channel:string:c", "file:string:f", "json:boolean:j", "mention:string", "plain:boolean",
      "reply-to:string", "role:string:r", "stdin:boolean", "to:string:t", "verbose:boolean:v",
    ],
    positionals: true,
  },
  // `chat` (2026-10): one live session per opening. `--kind` accepts only `endpoint`. `--role`,
  // `--link`, `--token`, `--creds` and `--lifecycle-uid` are declared and refuse until an admission
  // supports them.
  chat: {
    flags: [
      ...TARGET, "kind:string", "lifecycle-uid:string", "link:string", "name:string", "plain:boolean",
      "role:string", "stdio:boolean", "token:string",
    ],
    positionals: true,
  },
  // `channel` replaces `channels`: metadata, members (`--follow`), settings and `remove --purge`.
  channel: {
    flags: [
      ...TARGET, "delivery:string", "desc:string", "follow:boolean", "instructions:string", "json:boolean:j",
      "no-replay:boolean", "plain:boolean", "purge:boolean", "replay:boolean", "window:string", "yes:boolean:y",
    ],
    positionals: true,
  },
  // `history clear` confirms with `--yes` and previews with `--dry-run`; `--force` is the removed
  // spelling and refuses with that remedy.
  history: { flags: [...TARGET, "dms:boolean", "dry-run:boolean", "follow:boolean", "force:boolean", "from:string", "grep:string", "json:boolean:j", "limit:string", "plain:boolean", "since:string", "yes:boolean:y"], positionals: true },
  watch: { flags: [...TARGET, "json:boolean:j", "plain:boolean", "view:string"], positionals: false },
  // Held DMs of one agent, or one exact retired durable with `--durable`.
  pending: { flags: ["creds:string", "durable:string", "json:boolean:j", "limit:string", "plain:boolean", "server:string", "space:string"], positionals: true },
  // `service` (2026-10): one registry for built-in presets and user definitions; the action and the
  // name are positional. A preset's own options are declared by its adapter, not here.
  service: {
    flags: [
      "dry-run:boolean", "file:string:f", "follow:boolean", "foreground:boolean", "instance:string",
      "json:boolean:j", "new-instance:boolean", "plain:boolean", "preset:string", "space:string:s",
      "tail:string", "with-agents:boolean", "yes:boolean:y",
    ],
    positionals: true,
  },
  // Saved references, discovery and every control-surface verb. `--refresh` on describe refuses
  // because no contract is cached; `--handle`, `--since`, `--lease` and `--result` refuse until
  // their native adapters exist.
  endpoint: {
    flags: [
      ...TARGET, "admin:boolean", "all:boolean", "args:string", "cast:boolean", "dir:string", "dry-run:boolean",
      "file:string:f", "handle:string", "json:boolean:j", "lease:string", "live:boolean", "name:string",
      "on:string", "plain:boolean", "refresh:boolean", "result:string", "self:boolean", "since:string",
      "timeout:string", "wait:boolean", "yes:boolean:y",
    ],
    positionals: true,
  },
  // `run` (2026-09): the workflow-run operator surface from @cotal-ai/runtime. The run id is
  // minted by the driver (the records table forbids a caller-supplied id), so `start` takes no id
  // flag; resume/show/answer name an existing run positionally.
  // `--adopt` / `--release` / `--discard-approvals` (2026-09, #1863): what a `migrate` commit does
  // with an orphan or a recorded decision; the checking verb refuses them.
  // `--on` (2026-10, #3959): a hosted verb addresses one manager instance; `--local` refuses it.
  // `simulate --handler` scripts step results; `yield` takes `--status`, `--to` and `--note`.
  run: {
    flags: [
      ...TARGET, "admit-publish:string", "admit-read:string", "adopt:string", "artifact:string", "by:string",
      "cursor:string", "discard-approvals:boolean", "endpoint:string", "file:string:f", "handler:string",
      "json:boolean:j", "limit:string", "local:boolean", "note:string", "on:string", "page:boolean",
      "plain:boolean", "reason:string", "release:string", "status:string", "timeout:string", "to:string",
      "value:string",
    ],
    positionals: true,
  },
  login: { flags: ["client-id:string", "idp:string", "plain:boolean"], positionals: false },
  logout: { flags: ["idp:string", "json:boolean:j", "plain:boolean"], positionals: false },
  // Account metadata, actor grants (the actor ledger's flags), credential mint (`--endpoint` mints an
  // endpoint caller), signer export and `retire --yes`, which refuses until its native path exists.
  // `--full` (2026-10): a grant takes the wide ACL defaults only when asked; without it the grant
  // must name --scope, --allow-subscribe and --allow-publish.
  auth: {
    flags: [
      "allow-publish:string", "allow-subscribe:string", "channels:string", "endpoint:string", "expires-at:string",
      "expires-in:string", "force:boolean", "full:boolean", "identity:string", "json:boolean:j", "label:string",
      "out:string", "owner:string", "parent:string", "plain:boolean", "profile:string", "provision:boolean",
      "role:string", "scope:string", "server:string", "space:string:s", "sub:string", "yes:boolean:y",
    ],
    positionals: true,
  },
  // Stage 2b: feedback is the CLIENT only; the intake server is the feedback-intake service.
  // `--key-file` reads a protected key; `--key` refuses with that remedy.
  feedback: {
    flags: [
      "area:string", "details:string", "email:string", "json:boolean:j", "key:string", "key-file:string",
      "name:string", "plain:boolean", "severity:string", "type:string", "url:string",
    ],
    positionals: true,
  },
  // Guarded maintenance over the hidden `reconcile-gate` and `seats` command objects below.
  manager: { flags: ["drain:boolean", "dry-run:boolean", "endpoint:string", "instance:string", "json:boolean:j", "plain:boolean", "server:string", "space:string:s", "yes:boolean:y"], positionals: true },

  // ---- Hidden entries the design keeps --------------------------------------------------------
  // The four deprecated daemon entries keep their pre-cut parsers for persisted callers (OS units,
  // scripts, containers) and warn on each run. `up` launches the twins, which share each entry's
  // declaration without the warning.
  supervise: {
    flags: ["console-host:string", "console-port:string", "execution:string", "launch:string", "max-sessions:string", "resume-attempt:string", "resume-commit-file:string", "resume-commit-sha256:string", "resume-commit-token:string", "roster:string", "runtime:string", "server:string", "space:string", "spawn:string", "ws-port:string"],
    positionals: false,
  },
  "__daemon-manager": {
    flags: ["console-host:string", "console-port:string", "execution:string", "launch:string", "max-sessions:string", "resume-attempt:string", "resume-commit-file:string", "resume-commit-sha256:string", "resume-commit-token:string", "roster:string", "runtime:string", "server:string", "space:string", "spawn:string", "ws-port:string"],
    positionals: false,
  },
  deliver: {
    // `--tls` here is the daemon REQUIRING TLS to the broker, not offering it. Note that `join`
    // has carried a `tls:boolean` in this same inventory all along: the CLIENT half of TLS shipped
    // long ago and the SERVER half did not, which is this whole feature in one line.
    // `--root` (2026-10): name the workspace root instead of inheriting it from the cwd walk.
    flags: [
      "creds:string", "dev-mint:boolean", "durable:string", "json:boolean", "limit:string",
      "root:string", "server:string", "shard:string", "shards:string", "space:string", "tls:boolean",
    ],
    positionals: true,
  },
  "__daemon-deliver": {
    flags: [
      "creds:string", "dev-mint:boolean", "durable:string", "json:boolean", "limit:string",
      "root:string", "server:string", "shard:string", "shards:string", "space:string", "tls:boolean",
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
  "__daemon-auth-service": {
    flags: [
      "advertised-server:string", "agent-provisioning-url:string",
      "exchange-public-port:string", "exchange-public-url:string", "exchange-trusted-proxy:boolean",
      "port:string", "server:string", "space:string",
    ],
    positionals: false,
  },
  "feedback-intake": {
    flags: [
      "channel:string", "creds:string", "host:string", "keys:string", "max-bytes:string",
      "port:string", "rate-limit:string", "server:string", "space:string", "store:string",
    ],
    positionals: false,
  },
  // The owned completion stubs call this stable entry.
  __complete: { flags: [], positionals: true, rawArgs: true },
  // Gate 1 (user-mode agent launch): the machine-facing bearer refresh a spawned agent execs.
  // `--manager-call` / `--manager-instance` (2026-09): mint a token bound to one manager instance.
  "agent-bearer": {
    flags: [
      "actor:string", "dir:string", "exchange-url:string", "health-file:string", "manager-call:boolean",
      "manager-instance:string", "owner:string", "space:string", "token-file:string",
    ],
    positionals: false,
  },
  // `app-identity` (2026-10, #4082): hidden plumbing the Claude connector's local server runs to
  // open (`provision`) or retire one Claude app conversation's identity on a local mesh.
  "app-identity": { flags: ["dir:string", "events:boolean", "name:string", "require-approval:boolean", "selection:string", "session:string", "space:string"], positionals: true },
  // The children `service start` execs under controller custody, the owned user-unit entry and the
  // startup child `setup --start` execs. Each takes only the arguments its launcher writes.
  "__service-auth": {
    flags: [
      "advertised-server:string", "agent-provisioning-url:string", "exchange-public-port:string",
      "exchange-public-url:string", "exchange-trusted-proxy:boolean", "launch-request:string", "port:string",
      "ready-file:string", "root:string", "server:string", "service-instance:string", "space:string",
    ],
    positionals: false,
  },
  "__service-delivery": {
    flags: ["creds:string", "ready-file:string", "root:string", "server:string", "service-instance:string", "service-request:string", "space:string", "tls:boolean"],
    positionals: false,
  },
  "__service-exec-endpoint": {
    flags: [
      "closure:string", "contract:string", "handler:string", "handler-args:string", "handler-pin:string",
      "launch-request:string", "ready-file:string", "root:string", "server:string", "service-instance:string",
      "space:string",
    ],
    positionals: false,
  },
  "__service-feedback-intake": {
    flags: [
      "channel:string", "creds:string", "host:string", "keys:string", "max-bytes:string", "port:string",
      "rate-limit:string", "ready-file:string", "root:string", "server:string", "service-instance:string",
      "service-request:string", "space:string", "store:string", "tls:boolean",
    ],
    positionals: false,
  },
  // `--roster`: the manager preset's roster file, whose agents start at each launch.
  "__service-manager": {
    flags: [
      "console-host:string", "console-port:string", "launch:string", "launch-request:string", "launch-sha256:string",
      "max-sessions:string", "resume-attempt:string", "resume-commit-file:string", "resume-commit-sha256:string",
      "root:string", "roster:string", "runtime:string", "server:string", "service-instance:string", "space:string",
      "state-directory:string", "ws-port:string",
    ],
    positionals: false,
  },
  "__service-unit": { flags: ["control-home:string", "definition:string", "instance:string", "space:string"], positionals: false },
  "__setup-start": { flags: ["expected-version:string", "root:string", "space:string"], positionals: false },
  // The guarded exit from an issuance gate left frozen by a crashed manager restart (#391), and the
  // custody records an earlier Linux pty manager left (#1391). Both are hidden: `manager reconcile`
  // and `manager seats` run these same command objects, with -s on --space.
  "reconcile-gate": {
    flags: ["dry-run:boolean", "endpoint:string", "instance:string", "json:boolean:j", "plain:boolean", "server:string", "space:string", "yes:boolean:y"],
    positionals: false,
  },
  seats: { flags: ["drain:boolean", "dry-run:boolean", "json:boolean:j", "plain:boolean", "yes:boolean:y"], positionals: false },

  // ---- Migration tombstones -------------------------------------------------------------------
  // Each refuses with its literal replacement and keeps the old flags so the old line parses.
  // Stage 2a: `start` errors naming `spawn --detach`; never a silent alias.
  start: { flags: [], positionals: true, rawArgs: true },
  // `mint` moved to `auth mint` / `auth signer --out`.
  mint: {
    flags: [
      "allow-publish:string", "allow-subscribe:string", "channels:string", "endpoint:string", "expires-at:string",
      "expires-in:string", "force:boolean", "identity:string", "json:boolean:j", "out:string", "plain:boolean",
      "profile:string", "provision:boolean", "role:string", "server:string", "signer:boolean", "space:string:s",
    ],
    positionals: true,
  },
  // `deregister-instance` moved to `endpoint deregister <class> <full-instance-id>`.
  "deregister-instance": {
    flags: ["endpoint:string", "instance:string", "json:boolean:j", "plain:boolean", "server:string", "space:string"],
    positionals: false,
  },

  // ---- Legacy spellings still registered at this cut ------------------------------------------
  // The redesign replaces each of these; they still run. Remove or tombstone one, then update its
  // entry. Replacements: meshes -> space, join -> chat, endpoints -> who --all,
  // describe/invoke -> endpoint describe/invoke, console -> watch, personas -> persona,
  // topology -> team check --graph, clean -> reset / history clear / backup cleanup-fallback,
  // actor -> auth grants/grant/revoke.
  // `meshes` gained the registry-maintenance verbs (2026-08) and `--json` (2026-10, #2386).
  meshes: { flags: ["allow-unencrypted-overlay:boolean", "force:boolean", "from:string", "json:boolean", "mode:string", "root:string", "server:string", "tls:boolean", "user-auth-file:string"], positionals: true },
  join: {
    flags: [
      ...TARGET, "channel:string", "kind:string", "lifecycle-uid:string", "link:string",
      "name:string", "role:string", "tls:boolean", "token:string",
    ],
    positionals: false,
  },
  endpoints: { flags: [...TARGET, "json:boolean:j", "plain:boolean"], positionals: false },
  // The generic v0.4 service surface (P2 item 1, 1c.2b): describe an endpoint's registered
  // command set off the wire; invoke one command by name with JSON args.
  describe: { flags: [...TARGET, "json:boolean:j", "on:string", "plain:boolean"], positionals: true },
  invoke: {
    flags: [...TARGET, "admin:boolean", "all:boolean", "args:string", "cast:boolean", "handle:string", "json:boolean:j", "name:string", "on:string", "plain:boolean", "self:boolean", "timeout:string", "wait:boolean"],
    positionals: true,
  },
  console: { flags: [...TARGET, "plain:boolean"], positionals: false },
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
  topology: { flags: ["file:string:f"], positionals: true },
  clean: { flags: [...TARGET, "attempt:string", "dms:boolean", "force:boolean", "store-dir:string"], positionals: true },
  // Per-user auth (D4c): the actor-ledger operator surface.
  actor: {
    flags: [
      "allow-publish:string", "allow-subscribe:string", "full:boolean", "label:string", "owner:string",
      "parent:string", "role:string", "scope:string", "space:string", "sub:string",
    ],
    positionals: true,
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
  // The global flags are the kernel's, so a command that declared one would never receive it.
  for (const global of GLOBAL_FLAGS) assert.ok(!(cmd.flags ?? []).some((f) => f.name === global), `\`${cmd.name}\` does not declare the global --${global}`);
  // Every declared flag is parseable metadata: string flags carry a metavar or default help.
  for (const f of cmd.flags ?? []) {
    assert.ok(f.name && (f.type === "string" || f.type === "boolean"), `flag spec sane on ${cmd.name} --${f.name}`);
  }
}

console.log(`✓ flag-inventory smoke passed (${commands.length} commands)`);
emitSentinel({ passed: cells(), failed: 0 });
