import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { requireNativeLifecycleOperation, resolveNativeLifecycleProvider, NativeLifecycleUnsupported, type SessionOperationRecord } from "@cotal-ai/core";
import "../src/native-lifecycle.js";

let created = 100;
let version = "1.18.15";
let archived = false;
const requests: string[] = [];
const session = () => ({ id: "ses_fixture123", projectID: "project", directory: "/project", time: { created, updated: 200, ...(archived ? { archived: 300 } : {}) } });
const server = createServer((req, res) => {
  requests.push(`${req.method} ${req.url}`);
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(req.url === "/global/health" ? { healthy: true, version }
    : req.url === "/session" ? [session()]
    : req.url === "/session/status" ? { ses_fixture123: { type: "busy" } }
    : session()));
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
const addr = server.address();
assert.ok(addr && typeof addr !== "string");
const endpoint = `http://127.0.0.1:${addr.port}`;
const provider = resolveNativeLifecycleProvider("opencode");
const connection = provider.connect({ endpoint, hostIdentity: "host-fixture", nativeOwnerNamespace: "owner-fixture", password: "private-password" });
try {
  await test("registered provider construction performs no native effects", () => {
    assert.equal(provider.kind, "native-lifecycle");
    assert.equal(requests.length, 0);
    assert.equal(connection.capabilities.mode, "observed");
    assert.equal(connection.capabilities.acknowledgedControlFence, "unsupported");
    assert.throws(() => provider.connect({ endpoint, hostIdentity: "host", nativeOwnerNamespace: "owner", managementGranted: true }));
  });
  const observations = await requireNativeLifecycleOperation(connection, "discover")();
  const resource = observations[0].resourceKey;
  await test("discovery identifies stored sessions without inventing process or mesh ownership", () => {
    assert.equal(observations.length, 1);
    assert.equal(resource.stableSessionId, "ses_fixture123");
    assert.equal(observations[0].activity, "busy");
    assert.equal(observations[0].execution, "unknown");
    assert.equal(observations[0].mesh, "unknown");
    assert.equal(observations[0].incarnationProof, undefined);
  });
  await test("read-only inspection and view resolve through the registered provider", async () => {
    const inspected = await requireNativeLifecycleOperation(connection, "inspect")(resource);
    assert.deepEqual(inspected.resourceKey, resource);
    const view = await requireNativeLifecycleOperation(connection, "openView")(resource);
    assert.deepEqual(view.args, ["attach", endpoint, "--session", "ses_fixture123"]);
    assert.equal(view.credentialRequired, true);
    assert.ok(!JSON.stringify(view).includes("private-password"));
    assert.ok(!view.args.includes("--fork"));
    assert.ok(!view.args.includes("--continue"));
  });
  await test("foreign owner and host selectors refuse before network access", async () => {
    const count = requests.length;
    const inspect = requireNativeLifecycleOperation(connection, "inspect");
    await assert.rejects(inspect({ ...resource, hostIdentity: "other-host" }));
    await assert.rejects(inspect({ ...resource, nativeOwnerNamespace: "other-owner" }));
    assert.equal(requests.length, count);
  });
  await test("native creation identity change cannot reuse an enrolled resource selector", async () => {
    created++;
    await assert.rejects(requireNativeLifecycleOperation(connection, "inspect")(resource));
    created--;
  });
  await test("native version changes never manufacture a server incarnation proof", async () => {
    version = "1.18.16";
    const value = await requireNativeLifecycleOperation(connection, "inspect")(resource);
    assert.equal(value.providerVersion, "1.18.16");
    assert.equal(value.incarnationProof, undefined);
    assert.deepEqual(value.resourceKey, resource);
  });
  await test("unsupported mutation methods and preflight make no native request", async () => {
    const count = requests.length;
    for (const op of ["adopt", "release", "transfer", "recover"] as const) {
      assert.throws(() => requireNativeLifecycleOperation(connection, op), NativeLifecycleUnsupported);
      const checked = await requireNativeLifecycleOperation(connection, "preflight")(op, resource);
      assert.equal(checked.ok, false);
      assert.ok(!checked.ok && checked.code === "identity-unproven");
    }
    assert.equal(requests.length, count);
  });
  await test("archived metadata does not claim the session process exited or restart it", async () => {
    archived = true;
    const value = await requireNativeLifecycleOperation(connection, "inspect")(resource);
    assert.equal(value.execution, "unknown");
    assert.equal((value.evidence as { archivedAt: number }).archivedAt, 300);
    assert.ok(requests.every(request => request.startsWith("GET ")));
  });
  await test("operation lookup does not pretend session status is an operation receipt", async () => {
    const count = requests.length;
    const result = await requireNativeLifecycleOperation(connection, "queryOperation")({} as SessionOperationRecord);
    assert.equal(result.state, "indeterminate");
    assert.equal(requests.length, count);
  });
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
