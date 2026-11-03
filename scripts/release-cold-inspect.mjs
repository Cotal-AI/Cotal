#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, root, mode, snapshot] = process.argv.slice(2);
const workspace = await import(pathToFileURL(join(installed, "node_modules/@cotal-ai/workspace/dist/index.js")));
const dir = join(root, ".cotal");
if (mode === "running") {
  const rows = [];
  for (const name of readdirSync(dir).filter((name) => name.endsWith(".pid"))) {
    const file = join(dir, name);
    const pin = workspace.verifyIdentityPin(file);
    if (pin.kind !== "match") throw new Error(`cold setup: ${name} identity is ${pin.kind}`);
    rows.push({ name, pid: pin.record.pid, token: pin.record.token });
  }
  for (const component of ["nats", "manager", "delivery"]) {
    if (!rows.some((row) => row.name.startsWith(component + "."))) throw new Error(`cold setup: missing ${component} process`);
  }
  console.log(JSON.stringify(rows));
} else if (mode === "stopped") {
  const rows = JSON.parse(readFileSync(snapshot, "utf8"));
  for (const row of rows) {
    let zombie = false;
    if (process.platform === "linux") {
      try { const stat = readFileSync(`/proc/${row.pid}/stat`, "utf8"); zombie = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z "); } catch {}
    }
    const current = workspace.defaultStartToken(row.pid);
    if (!zombie && workspace.probeLiveness(row.pid) !== "dead")
      assert(current !== undefined && current !== row.token, `cold setup: ${row.name} generation is live or its exit cannot be verified`);
  }
  const remaining = readdirSync(dir).filter((name) => name.endsWith(".pid") || name.endsWith(".pid.identity"));
  if (remaining.length) throw new Error(`cold setup: process records remain: ${remaining.join(", ")}`);
  console.log(JSON.stringify({ generationsStopped: rows.length, recordsRemaining: 0 }));
} else if (mode === "self") {
  const path = join(root, "cold-identity.pid");
  assert(!existsSync(path) && !existsSync(workspace.identityPinPath(path)), "cold identity probe already exists");
  try {
    workspace.writePidPair(path, process.pid);
    assert(workspace.verifyIdentityPin(path).kind === "match", "native cold process creation identity must round-trip");
    console.log(JSON.stringify({ nativeIdentity: true }));
  } finally {
    rmSync(path, { force: true });
    rmSync(workspace.identityPinPath(path), { force: true });
  }
} else if (mode === "policy") {
  const context = { root, space: snapshot };
  const pidPath = workspace.canonicalLocalProcessPath(workspace.MANAGER_PIDFILE, context);
  const pin = workspace.verifyIdentityPin(pidPath);
  assert(pin.kind === "match", "shutdown policy needs the live manager's identity");
  const marker = workspace.stopReservationPath(pidPath);
  const intent = workspace.canonicalLocalProcessPath(workspace.MANAGER_SHUTDOWN_INTENT, context);
  assert(!existsSync(intent), "fresh manager already has a shutdown intent");
  writeFileSync(marker, String(process.pid), { flag: "wx", mode: 0o600 });
  try {
    workspace.armManagerShutdownIntent(context, { target: pin.record, stopper: { pid: process.pid, marker } });
    const decision = workspace.consumeManagerShutdownIntent(context, pin.record.pid);
    assert(decision.withAgents === true, "native creation tokens must survive the destructive-policy handoff");
    assert(workspace.consumeManagerShutdownIntent(context, pin.record.pid).withAgents === false, "shutdown policy cannot replay");
    console.log(JSON.stringify({ nativeTokensAccepted: true, oneShot: true }));
  } finally {
    workspace.disarmManagerShutdownIntent(context);
    rmSync(marker);
  }
} else throw new Error("cold setup: unknown inspection mode");
