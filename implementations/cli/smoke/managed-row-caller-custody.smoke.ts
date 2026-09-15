import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ManagedRowAttemptError,
  createSpaceAuth,
  readProviderMutationRequest,
  registry,
  stableProviderMutationRequestId,
  type AuthProvider,
  type ManagedRowAttempt,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, userAuthStateDir } from "@cotal-ai/workspace";
import { provisionUserForeground } from "../src/commands/spawn.js";

const OWNER = "u_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const CLI_UID = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const TARGET_UID = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPACE = "task84";
const caller = { owner: OWNER, actor: "cli", uid: CLI_UID };
const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "task84-cli-caller-custody-"));
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), await createSpaceAuth(SPACE));

const attempts: ManagedRowAttempt[] = [];
let stageCalls = 0;
const provider: Pick<AuthProvider, "kind" | "name" | "agentBearerCommand" | "ownerForLogin" | "stageManagedRowCreate" | "sendManagedRowAttempt"> = {
  kind: "auth-provider",
  name: "task84-cli-caller-custody",
  agentBearerCommand: "agent-bearer",
  ownerForLogin: async () => OWNER,
  stageManagedRowCreate: async () => {
    stageCalls++;
    return { actorToken: "fixed-caller-custody-token", sentinelCreds: "fixed-caller-custody-sentinel" };
  },
  sendManagedRowAttempt: async ({ attempt }) => {
    attempts.push(attempt);
    if (attempt.command === "create-managed-row")
      throw new ManagedRowAttemptError("injected ambiguous create", "unknown");
    throw new ManagedRowAttemptError("injected ambiguous rollback", "unknown");
  },
};
registry.register(provider as AuthProvider);

const originalExit = process.exit;
const originalError = console.error;
const errors: string[] = [];
console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
(process as unknown as { exit(code?: number): never }).exit = ((code?: number) => { throw new Error(`process.exit:${code}`); }) as never;
try {
  let surfaced = "";
  try {
    await provisionUserForeground(
      { root, space: SPACE, server: "nats://127.0.0.1:1", mode: "user" } as never,
      "worker",
      "worker",
      { allowSubscribe: [], allowPublish: [], capabilities: ["run"], lifecycleUid: TARGET_UID, caller },
    );
  } catch (error) {
    surfaced = `${errors.join("\n")}\n${error instanceof Error ? error.message : String(error)}`;
  }

  assert.equal(stageCalls, 1);
  assert.equal(attempts.length, 2);
  const [create, rollback] = attempts;
  assert.equal(create.command, "create-managed-row");
  assert.equal(rollback.command, "revoke-managed-row");
  assert.deepEqual(create.caller, caller);
  assert.deepEqual(rollback.caller, caller);
  assert.equal(create.intent.target.lifecycleUid, TARGET_UID);
  assert.equal(rollback.intent.target.lifecycleUid, TARGET_UID);
  assert.equal(create.intent.requestId, stableProviderMutationRequestId({ kind: "grant", owner: OWNER, actor: "worker", lifecycleUid: TARGET_UID, operationId: `cli-foreground:${TARGET_UID}` }));
  assert.equal(rollback.intent.requestId, stableProviderMutationRequestId({ kind: "revoke", owner: OWNER, actor: "worker", lifecycleUid: TARGET_UID, operationId: `cli-rollback:${TARGET_UID}` }));
  assert.notEqual(create.intent.requestId, rollback.intent.requestId);
  const pending = readProviderMutationRequest(userAuthStateDir(root, SPACE), rollback.intent.requestId);
  assert.equal(pending?.state, "pending");
  assert.deepEqual(pending?.caller, caller);
  assert.match(surfaced, /injected ambiguous create/);
  assert.match(surfaced, /managed-row rollback remains pending for retry \(injected ambiguous rollback; caller knowledge=unknown\)/);
  assert.match(surfaced, /caller knowledge=unknown/);
  console.log("TASK84 CLI CALLER CUSTODY STANDARD ATTEMPTS 17 passed, 0 failed");
} finally {
  console.error = originalError;
  process.exit = originalExit;
  registry.unregister("auth-provider", provider.name);
  rmSync(root, { recursive: true, force: true });
}
