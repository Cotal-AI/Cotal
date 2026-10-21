/**
 * `cotal login` against a provider that cannot be reached is a dependency refusal:
 * DEPENDENCY_UNAVAILABLE (exit 2) with the request that failed, a remedy naming `--idp`, and no
 * cached session. That holds for a closed port and for a provider that accepts the connection and
 * never answers. Broker-free; the session cache is private to this run.
 *
 * Run: pnpm smoke:login-unreachable
 */
import { strict as nodeAssert } from "node:assert";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registry, type Command } from "@cotal-ai/core";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { exitCode, homeCotalDir, isCommandFailure, type CommandFailure } from "@cotal-ai/workspace";
import { loadIdpSession } from "../src/index.js";

const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const priorHome = process.env.COTAL_HOME;
const priorTimeout = process.env.COTAL_IDP_TIMEOUT_MS;
const base = mkdtempSync(join(tmpdir(), "cotal-login-unreachable-"));
process.env.COTAL_HOME = join(base, "home");

const loginCommand = registry.all<Command>("command").find((command) => command.name === "login");
if (!loginCommand) throw new Error("the login command is not registered");

const listen = (server: Server) => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
const close = (server: Server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });

/** The failure `cotal login --idp <idp>` ends with. */
async function login(idp: string): Promise<CommandFailure> {
  const args = { values: { idp }, positionals: [], raw: [] };
  try {
    loginCommand!.validate?.(args);
    await loginCommand!.run(args);
  } catch (error) {
    if (isCommandFailure(error)) return error;
    throw error;
  } finally {
    process.exitCode = 0;
  }
  throw new Error(`login --idp ${idp} did not refuse`);
}

/** An unreachable provider's refusal: a dependency refusal, exit 2, nothing cached. */
function assertUnreachable(failure: CommandFailure, idp: string, cause: RegExp, name: string): void {
  assert.equal(failure.outcome, "refused", `${name}: outcome`);
  assert.equal(failure.code, "DEPENDENCY_UNAVAILABLE", `${name}: code (${failure.message})`);
  assert.equal(exitCode(failure.outcome, failure.code), 2, `${name}: exit code`);
  assert.ok(failure.message.includes(`idp request to ${idp}/device/code`), `${name}: the message names the request: ${failure.message}`);
  assert.match(failure.message, cause, `${name}: the message says why`);
  assert.match(failure.message, /no session was cached$/, `${name}: the message says nothing was cached`);
  assert.equal(failure.remedy, "check --idp <auth base URL>; it must serve <base>/device/code", `${name}: remedy`);
  assert.equal(loadIdpSession(homeCotalDir(), idp), undefined, `${name}: no session is cached`);
}

try {
  // 1. A closed port: the transport fails.
  {
    const probe = createServer();
    const port = await listen(probe);
    await close(probe);
    const idp = `http://127.0.0.1:${port}`;
    assertUnreachable(await login(idp), idp, /failed: /, "a closed port");
  }

  // 2. A provider that accepts the connection and never answers: the request times out.
  {
    const silent = createServer(() => {});
    const idp = `http://127.0.0.1:${await listen(silent)}`;
    process.env.COTAL_IDP_TIMEOUT_MS = "300";
    try {
      assertUnreachable(await login(idp), idp, /timed out after 300ms/, "a provider that never answers");
    } finally {
      await close(silent);
    }
  }
} finally {
  if (priorTimeout === undefined) delete process.env.COTAL_IDP_TIMEOUT_MS;
  else process.env.COTAL_IDP_TIMEOUT_MS = priorTimeout;
  if (priorHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = priorHome;
  rmSync(base, { recursive: true, force: true });
}

console.log("login-unreachable smoke: OK - login against a closed port or a silent provider refuses with DEPENDENCY_UNAVAILABLE (exit 2), names the failed request and the --idp remedy, and caches no session");
emitSentinel({ passed: cells(), failed: 0 });
