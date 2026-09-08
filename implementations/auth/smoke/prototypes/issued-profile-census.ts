import assert from "node:assert/strict";
import {
  CREDENTIAL_LIFETIMES, permissionsFor, epServeGrantRows, patternCovers,
  type Profile, type MintOpts, type MintPrincipal,
} from "@cotal-ai/core";
import { calloutPermissions } from "../../src/permissions.js";
import { USER_TOKEN_VER, USER_TOKEN_VIEWS, VIEW_REQUIRED_SCOPE } from "../../src/token.js";
import { deriveOwnerToken } from "../../src/derive.js";

export interface ProfileFixture {
  profile: Profile;
  variant: string;
  permissions: Record<string, unknown>;
  producer: "permissionsFor" | "epServeGrantRows" | "calloutPermissions";
}
export function profileFixtures(space: string): ProfileFixture[] {
  const uid = "u".repeat(26), instance = "i".repeat(26), session = "s".repeat(26);
  const principal: MintPrincipal = { owner: "local", actor: "census", connId: "census0123456789abcdef", lifecycleUid: uid };
  const rows: ProfileFixture[] = [];
  const one = (profile: Profile, opts: MintOpts = {}, variant = "default", pr = principal): void => {
    rows.push({ profile, variant, permissions: permissionsFor(profile, space, pr, opts), producer: "permissionsFor" });
  };
  const run = { endpoint: "manager", runId: "census-run", takeoverId: "take0001", instanceId: instance, epoch: 1 };
  const producers: Record<Profile, () => void> = {
    agent() {
      one("agent");
      one("agent", { capabilities: ["spawn", "run"], role: "worker", allowPublish: [">"], allowSubscribe: [">"] }, "spawn-run-role");
      one("agent", { allowPublish: [], allowSubscribe: [] }, "empty-channel-scope");
    },
    observer: () => one("observer"), admin: () => one("admin"), supervisor: () => one("supervisor"),
    provisioner: () => one("provisioner"),
    deprovisioner: () => one("deprovisioner", { deprovisionTarget: { principal: "local.worker", lifecycleUid: uid } }),
    "retirement-requester": () => one("retirement-requester", { retirementRequester: { owner: "local", actor: "census", uid, target: { owner: "local", actor: "worker", lifecycleUid: uid } } }),
    "lifecycle-executor": () => one("lifecycle-executor", { lifecycleExecutor: { owner: "local", actor: "worker", lifecycleUid: uid, alias: "worker" } }),
    "endpoint-serve-executor": () => one("endpoint-serve-executor", { endpointServeExecutor: { endpoint: "manager", instanceId: instance } }),
    operator: () => one("operator"), purger: () => one("purger"),
    backup: () => one("backup", { backup: { operation: "inspect", selection: "full" } }),
    restore: () => one("restore", { restore: { operation: "initiate", stream: `CHAT_${space}` } }),
    delivery: () => one("delivery"), "membership-rw": () => one("membership-rw"),
    probe: () => one("probe"), "channel-writer": () => one("channel-writer"), "channel-purger": () => one("channel-purger"),
    teardown: () => one("teardown"),
    "control-caller-privileged": () => one("control-caller-privileged"),
    "control-caller-admin": () => one("control-caller-admin"),
    deployer() { one("deployer"); one("deployer", { controlTier: "privileged" }, "privileged-tier"); },
    "endpoint-serve"() {
      const grant = epServeGrantRows(space, { endpoint: "manager", instanceId: instance, epoch: 1, ephemeralCommands: ["ps", "run-start", "run-resume"] });
      rows.push({ profile: "endpoint-serve", variant: "raw-serve-rows", permissions: { pub: { allow: grant.pub }, sub: { allow: grant.sub } }, producer: "epServeGrantRows" });
    },
    "goal-writer": () => one("goal-writer", { goalWriter: { endpoint: "manager" } }),
    "session-caller": () => one("session-caller", { sessionCaller: { endpoint: "manager", sessionId: session, epoch: 1 } }),
    "session-serving": () => one("session-serving", { sessionServing: { endpoint: "manager", sessionId: session, epoch: 1 } }),
    "session-ledger": () => one("session-ledger"),
    "run-driver": () => one("run-driver", { runDriver: run }),
    "run-mediator": () => one("run-mediator", { runMediator: run }),
    "run-operator": () => one("run-operator", { runOperator: { endpoint: "manager", takeoverId: "take0001" } }),
    "endpoint-evictor": () => one("endpoint-evictor"),
    "remote-manager"() {
      for (const actor of [`manager_${instance}`, `manager_exec_${instance}`]) {
        one("remote-manager", { remoteManager: { owner: "local", instanceId: instance, actor } }, actor.startsWith("manager_exec") ? "executor" : "server", { ...principal, actor });
      }
    },
  };
  const nonProfiles = ["membership-observer", "connection-evictor"];
  assert.deepEqual(Object.keys(producers).sort(), Object.keys(CREDENTIAL_LIFETIMES).filter((kind) => !nonProfiles.includes(kind)).sort(), "every Profile must have a producer");
  for (const produce of Object.values(producers)) produce();
  const owner = deriveOwnerToken("census-prototype-secret".repeat(2), "view-owner");
  for (const view of USER_TOKEN_VIEWS) {
    const scope = [VIEW_REQUIRED_SCOPE[view]];
    const token = { owner, space, scope, ver: USER_TOKEN_VER, exp: 2_000_000_000, act: { owner, actor: "census", scope, lifecycleUid: uid, view } };
    const produce = calloutPermissions(() => ({ scope, lifecycleUid: uid, allowPublish: ["public"], allowSubscribe: ["public"] }));
    if (view === "manager-service") {
      assert.throws(() => produce(token, principal.connId), /typed material exchange/);
      continue; // Explicit refused view, represented separately from Profile in the report.
    }
    rows.push({ profile: view, variant: `callout-view:${view}`, permissions: produce(token, principal.connId), producer: "calloutPermissions" });
  }
  assert.deepEqual(rows.filter((row) => row.producer === "calloutPermissions").map((row) => row.variant).sort(),
    USER_TOKEN_VIEWS.filter((view) => view !== "manager-service").map((view) => `callout-view:${view}`).sort(),
    "every generic callout view must have a producer");
  return rows;
}

// Conservative intersection with the whole candidate namespace, not merely one request.
// Queue qualifiers do not widen subject space; retain them in the reported original row.
export function namespaceOverlap(row: string, space: string): boolean {
  const pattern = row.split(" ")[0].split(".");
  const prefix = ["cotal", space, "ep", "v1"];
  for (let i = 0; i < prefix.length; i++) {
    if (pattern[i] === ">") return true;
    if (pattern[i] !== "*" && pattern[i] !== prefix[i]) return false;
  }
  return pattern.length > prefix.length;
}
export function namespaceGrants(permissions: Record<string, unknown>, space: string, direction: "pub" | "sub") {
  const value = permissions[direction] as { allow?: string[]; deny?: string[] } | undefined;
  const allow = value?.allow?.length ? value.allow : [">"];
  const deny = value?.deny ?? [];
  const overlaps = allow.filter((row) => namespaceOverlap(row, space));
  const wholeNamespaceDenied = deny.some((row) => !row.includes(" ") && patternCovers(row, `cotal.${space}.ep.v1.>`));
  return { overlaps, deny, potential: overlaps.length > 0 && !wholeNamespaceDenied };
}
