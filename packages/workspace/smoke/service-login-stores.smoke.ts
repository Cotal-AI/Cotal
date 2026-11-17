import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spaceKey } from "../src/auth-paths.js";
import { serviceLoginStores, serviceLoginStoresReport, assertServiceLoginStore, serviceLoginRecovery } from "../src/service-login-stores.js";

if (process.platform === "linux") {
  const root = mkdtempSync(join(tmpdir(), "service-login-stores-"));
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  try {
    process.env.HOME = join(root, "home"); process.env.XDG_CONFIG_HOME = join(root, "config");
    const units = join(process.env.HOME, ".config/systemd/user"), customUnits = join(process.env.XDG_CONFIG_HOME, "systemd/user");
    mkdirSync(units, { recursive: true, mode: 0o700 }); mkdirSync(customUnits, { recursive: true, mode: 0o700 });
    writeFileSync(join(units, "unrelated.service"), "[Service]\nExecStart=/usr/bin/true\n", { mode: 0o666 });
    chmodSync(join(units, "unrelated.service"), 0o666);
    assert.deepEqual(serviceLoginStores(), []);
    const store = join(root, "private"), custom = join(root, "custom");
    mkdirSync(store, { mode: 0o700 }); mkdirSync(custom, { mode: 0o700 });
    const env = join(root, "manager.env");
    const render = (name: string, values: Record<string, string>) => readFileSync(resolve("bin/smoke/fixtures", name), "utf8").replace(/@([A-Z_]+)@/g, (_, key: string) => values[key]!);
    writeFileSync(env, render("pre-cut-manager-unit.env", { PATH: "/usr/bin", SPACE: "fixture", SERVER: "nats://localhost:4222", STATE_DIR: store }), { mode: 0o600 });
    const unit = join(units, `cotal-manager@${spaceKey("fixture")}.service`);
    const source = render("pre-cut-manager-unit.service", { MESH: "fixture", ROOT: root, WORKING_DIRECTORY: root, ENVIRONMENT_FILE: env, ENTRY: "/usr/bin/node --import tsx /fixture/bin/cotal.ts" });
    writeFileSync(unit, source, { mode: 0o600 });
    writeFileSync(join(customUnits, "arbitrary.service"), `[Service]\nExecStart=/usr/bin/cotal supervise\nEnvironment="COTAL_HOME=${custom}"\n`, { mode: 0o600 });
    const stores = serviceLoginStores(); assert.equal(stores.length, 1);
    chmodSync(units, 0o777); assert.throws(serviceLoginStores); chmodSync(units, 0o700);
    const config = join(process.env.HOME, ".config");
    renameSync(config, `${config}.old`); symlinkSync(`${config}.old`, config);
    assert.throws(serviceLoginStores, "a symlinked configuration ancestor cannot redirect discovery");
    rmSync(config); renameSync(`${config}.old`, config);
    const legacy = stores.find((s) => s.directory === store)!;
    assert.equal(legacy.unitPath, unit); assertServiceLoginStore(legacy);
    assert.equal(serviceLoginRecovery("https://idp.test", store).includes(`cotal-manager@${spaceKey("fixture")}.service`), true);
    assert.throws(() => assertServiceLoginStore({ ...legacy }));
    writeFileSync(env, `COTAL_HOME="${custom}"\n`, { mode: 0o600 });
    assert.throws(() => assertServiceLoginStore(legacy));
    writeFileSync(env, `COTAL_HOME="${store}"\n`, { mode: 0o600 });
    const fresh = serviceLoginStores()[0]!;
    renameSync(store, `${store}.old`); mkdirSync(store, { mode: 0o700 });
    assert.throws(() => assertServiceLoginStore(fresh));
    chmodSync(store, 0o777); assert.throws(serviceLoginStores); chmodSync(store, 0o700);
    renameSync(env, `${env}.old`); symlinkSync(`${env}.old`, env); assert.throws(serviceLoginStores);
    rmSync(env); renameSync(`${env}.old`, env);
    mkdirSync(`${unit}.d`, { mode: 0o700 }); assert.throws(serviceLoginStores); rmSync(`${unit}.d`, { recursive: true });
    writeFileSync(unit, source + "Environment=COTAL_HOME=/ambiguous\n");
    // This is in [Install], so it does not change the service environment.
    assert.equal(serviceLoginStores().length, 1);
    writeFileSync(unit, source.replace("EnvironmentFile=", "Environment=COTAL_HOME=/ambiguous\nEnvironmentFile="));
    assert.throws(serviceLoginStores);
    writeFileSync(unit, source.replace("EnvironmentFile=", "EnvironmentFile=-")); assert.throws(serviceLoginStores);
    writeFileSync(unit, source);
    const siblingName = `cotal-manager@${spaceKey("sibling")}.service`;
    const sibling = join(units, siblingName);
    writeFileSync(sibling, source.replace("# cotal-mesh: fixture", "# cotal-mesh: sibling"), { mode: 0o600 });
    mkdirSync(`${sibling}.d`, { mode: 0o700 });
    writeFileSync(join(`${sibling}.d`, "telemetry-off.conf"), "[Service]\nEnvironment=DO_NOT_TRACK=1\n", { mode: 0o600 });
    const mixed = serviceLoginStoresReport();
    assert.deepEqual(mixed.stores.map(s => s.unitPath), [unit]);
    assert.deepEqual(mixed.skipped, [{ service: siblingName, reason: "local-overrides" }]);
    assertServiceLoginStore(mixed.stores[0]!);
    assert.throws(serviceLoginStores);
    assert.ok(serviceLoginRecovery("https://idp.test", store).includes(`cotal-manager@${spaceKey("fixture")}.service`));
    rmSync(`${sibling}.d`, { recursive: true });
    const template = join(units, "cotal-manager@.service.d");
    mkdirSync(template, { mode: 0o700 });
    writeFileSync(join(template, "telemetry-off.conf"), "[Service]\nEnvironment=DO_NOT_TRACK=1\n", { mode: 0o600 });
    const overridden = serviceLoginStoresReport();
    assert.equal(overridden.stores.length, 0);
    assert.equal(overridden.skipped.length, 2);
    assert.ok(overridden.skipped.every(s => s.reason === "local-overrides"));
    assert.throws(serviceLoginStores);
    rmSync(template, { recursive: true });
    writeFileSync(join(customUnits, siblingName), source.replace("# cotal-mesh: fixture", "# cotal-mesh: sibling"), { mode: 0o600 });
    const duplicate = serviceLoginStoresReport();
    assert.deepEqual(duplicate.stores.map(s => s.unitPath), [unit]);
    assert.deepEqual(duplicate.skipped, [{ service: siblingName, reason: "unproven" }]);
    assert.throws(serviceLoginStores);
    console.log("PASS tolerant discovery: mixed units, template overrides, proven recovery and duplicate invalidation");
    console.log("PASS service login discovery: legacy product unit, custom unit excluded, source/store pins, physical paths and parser refusals");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
