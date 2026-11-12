import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { serviceLoginStores, assertServiceLoginStore, serviceLoginRecovery } from "../src/service-login-stores.js";

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
    const unit = join(units, "cotal-manager@abcd.service");
    const source = render("pre-cut-manager-unit.service", { MESH: "fixture", ROOT: root, WORKING_DIRECTORY: root, ENVIRONMENT_FILE: env, ENTRY: "/usr/bin/node --import tsx /fixture/bin/cotal.ts" });
    writeFileSync(unit, source, { mode: 0o600 });
    writeFileSync(join(customUnits, "arbitrary.service"), `[Service]\nExecStart=/usr/bin/cotal supervise\nEnvironment="COTAL_HOME=${custom}"\n`, { mode: 0o600 });
    const stores = serviceLoginStores(); assert.equal(stores.length, 2);
    const legacy = stores.find((s) => s.directory === store)!;
    assert.equal(legacy.unitPath, unit); assertServiceLoginStore(legacy);
    assert.match(serviceLoginRecovery("https://idp.test", store), /cotal-manager@abcd.service/);
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
    assert.equal(serviceLoginStores().length, 2);
    writeFileSync(unit, source.replace("EnvironmentFile=", "Environment=COTAL_HOME=/ambiguous\nEnvironmentFile="));
    assert.throws(serviceLoginStores);
    writeFileSync(unit, source.replace("EnvironmentFile=", "EnvironmentFile=-")); assert.throws(serviceLoginStores);
    console.log("PASS service login discovery: legacy, custom, source/store pins, physical paths and parser refusals");
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  }
}
