/**
 * FIXTURE delivery daemon entry point — deliberately NOT spawned as `cotal deliver`.
 *
 * WHY THIS FILE EXISTS, and it is not a style preference:
 *
 * Process supervisors commonly identify a daemon by pattern-matching the process table. A matcher
 * for the delivery daemon that keys on the command path (`cotal.ts deliver`) carries NO SPACE
 * DISCRIMINATOR, so it cannot distinguish a production daemon from a test fixture running the same
 * command in an isolated space against a loopback broker. If such a supervisor then ACTS on the
 * match — restarting, killing, or counting instances — a smoke run and a production deployment are
 * the same object to it.
 *
 * A fixture spawned as `tsx bin/cotal.ts deliver --space <test> --server nats://127.0.0.1:<port>`
 * is exactly that collision. Worse, the three-process tree (pnpm -> tsx -> node) puts the matched
 * string in argv MORE THAN ONCE, so a supervisor that counts matches to detect duplicate daemons
 * sees several where there is one.
 *
 * Fixing the matcher is the supervisor's job. Not being matchable is ours, and it is the half we
 * control: this entry point's argv contains neither `cotal.ts` nor a bare `deliver` token, and it
 * sets a loud process title, so a supervisor looking for the production daemon cannot see it. A
 * test fixture should never be mistakable for the thing it is a fixture of.
 *
 * THE SUBSTITUTION, STATED RATHER THAN HIDDEN: the registered CLI command is literally
 * `run: (args) => runDelivery(args)` (`implementations/delivery/src/index.ts`), so this process runs
 * the SAME daemon function through a different composition root. What differs is the argv and the
 * process tree depth — not the daemon under test. What this fixture therefore no longer exercises
 * is the CLI's own flag parsing for `deliver`; that is a real (small) loss of coverage and it is
 * named here rather than left for a reader to discover.
 */
import { runDelivery } from "@cotal-ai/delivery";

const FIXTURE_MARKER = "COTAL-SMOKE-FIXTURE-NOT-A-PRODUCTION-DAEMON";

const [, , space, server, creds] = process.argv;
if (!space || !server || !creds) {
  console.error(`${FIXTURE_MARKER}: usage: _fixture-daemon.mts <space> <server> <creds>`);
  process.exit(2);
}

// FIRST ACTION, before the daemon connects to anything: refuse the live host outright. The suite
// asserts this too, but a fixture that can be launched by hand must carry its own guard rather than
// inherit one from its usual caller.
const LIVE = "broker.cotal.ai";
if (server.includes(LIVE)) {
  console.error(`${FIXTURE_MARKER}: REFUSING TO RUN — broker URL ${server} names the live host ${LIVE}`);
  process.exit(1);
}
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(server)) {
  console.error(`${FIXTURE_MARKER}: REFUSING TO RUN — broker URL ${server} is not a loopback ephemeral broker`);
  process.exit(1);
}

// Visible in `ps` output, so a human reading the process table sees what this is immediately.
process.title = FIXTURE_MARKER;

await runDelivery({ values: { space, server, creds }, positionals: [], raw: [] });
