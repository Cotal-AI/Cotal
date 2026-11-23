/**
 * A Codex launch that asks before it uses a tool (`askPermissions`), with no broker.
 *
 * The shipped override list and the shipped driver run against the scripted fake app-server. An
 * asking launch starts its thread in T3 Code's approval-required mode and leaves out the autonomy
 * defaults. It is refused when a launch option sets what it sets. A launch without it keeps the
 * defaults and starts its thread as before. A permissions request no prompt desk holds grants
 * nothing.
 *
 * Run: pnpm smoke:codex-ask-permissions
 */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_MATERIAL_ENV, readLaunchMaterial, type LaunchOpts } from "@cotal-ai/core";
import { createSuite, skipSuite } from "@cotal-ai/smoke-kit";
import { AppServerDriver } from "../src/app-server.js";
import { ASKING_THREAD, configOverrides } from "../src/codex-config.js";
import { codexConnector } from "../src/extension.js";

if (process.platform === "win32") skipSuite("managed Codex agents are POSIX-only");

const { check, finish } = createSuite();

const refusal = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};
const value = (overrides: [string, string][], key: string): string | undefined => overrides.find(([k]) => k === key)?.[1];

const asking = configOverrides("gpt", undefined, true, true);
check(
  "an asking launch sets no approval_policy, sandbox_mode or network default",
  ["approval_policy", "sandbox_mode", "sandbox_workspace_write"].every((k) => value(asking, k) === undefined),
  asking,
);
const plain = configOverrides("gpt", undefined, true, false);
check(
  "a launch without it keeps approval_policy never and the workspace-write sandbox",
  value(plain, "approval_policy") === '"never"' && value(plain, "sandbox_mode") === '"workspace-write"',
  plain,
);
for (const key of ["approval_policy", "sandbox_mode", "approvals_reviewer"]) {
  process.env.COTAL_CODEX_CONFIG = JSON.stringify({ [key]: '"on-request"' });
  check(`an asking launch whose options set ${key} is refused`, refusal(() => configOverrides("gpt", undefined, true, true)).includes(`askPermissions sets ${key} itself`));
}
delete process.env.COTAL_CODEX_CONFIG;
check("the Codex connector declares supportsAskPermissions", codexConnector.supportsAskPermissions === true);

/** What the seat reads from the launch material `opts` builds. */
const material = (opts: Partial<LaunchOpts>) => {
  const userAuth = { owner: "o", actor: "a", sentinelCredsPath: "/tmp/sc", bearerCmd: ["cmd"] };
  const spec = codexConnector.buildLaunch({ space: "s", name: "n", events: false, userAuth, ...opts });
  return readLaunchMaterial(spec.env?.[LAUNCH_MATERIAL_ENV] as string);
};
check("an asking launch hands askPermissions to the seat in its launch material", material({ askPermissions: true }).askPermissions === true);
check("a launch without it hands none", material({}).askPermissions === undefined);

const dir = mkdtempSync(join(tmpdir(), "codex-ask-"));
const BIN = join(dir, "fake-codex");
writeFileSync(BIN, `#!/bin/sh\nexec "${process.execPath}" "${fileURLToPath(new URL("./fake-codex.mjs", import.meta.url))}" "$@"\n`);
chmodSync(BIN, 0o755);
const LOG = join(dir, "fake.log.jsonl");
process.env.FAKE_CODEX_LOG = LOG;

/** The `thread/start` params a driver sends with `threadSettings`. */
async function threadStart(threadSettings?: Readonly<Record<string, unknown>>): Promise<Record<string, unknown> | undefined> {
  rmSync(LOG, { force: true });
  const driver = new AppServerDriver({ cwd: dir, codexHome: dir, configOverrides: [], bin: BIN, threadSettings, log: () => {} });
  try {
    await driver.start();
  } finally {
    await driver.stop();
  }
  const entries = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ev: string; method?: string; params?: Record<string, unknown> });
  return entries.find((e) => e.ev === "recv" && e.method === "thread/start")?.params;
}

try {
  const asked = await threadStart(ASKING_THREAD);
  check(
    "an asking thread starts with approvalPolicy untrusted, a read-only sandbox and the user as reviewer",
    asked?.approvalPolicy === "untrusted" && asked?.sandbox === "read-only" && asked?.approvalsReviewer === "user" && asked?.cwd === dir,
    asked,
  );
  const unasked = await threadStart();
  check(
    "a thread without it starts with none of those settings",
    unasked !== undefined && !("approvalPolicy" in unasked) && !("sandbox" in unasked) && !("approvalsReviewer" in unasked),
    unasked,
  );
  rmSync(LOG, { force: true });
  const driver = new AppServerDriver({ cwd: dir, codexHome: dir, configOverrides: [], bin: BIN, log: () => {} });
  const waits: { detail: string; code?: string }[] = [];
  driver.on("waiting", (detail: string, condition?: { code: string }) => waits.push({ detail, code: condition?.code }));
  let answer: unknown;
  try {
    await driver.start();
    await driver.startTurn("PERMREQ probe");
    for (let i = 0; i < 100 && answer === undefined; i++) {
      await new Promise((r) => setTimeout(r, 50));
      const entries = readFileSync(LOG, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { ev: string; answer?: unknown });
      answer = entries.find((e) => e.ev === "permissionsAnswer")?.answer;
    }
  } finally {
    await driver.stop();
  }
  check("a permissions request no prompt desk holds grants nothing", JSON.stringify(answer) === JSON.stringify({ permissions: {}, scope: "turn" }), answer);
  check("and it relays the approval condition while it waits", waits.some((w) => w.detail === "item/permissions/requestApproval" && w.code === "approval"), waits);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

finish();
