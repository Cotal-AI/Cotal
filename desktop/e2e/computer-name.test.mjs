import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./first-run.ts", import.meta.url), "utf8");

test("account name acceptance uses UI Enter and real daemon reads before and after native reopen", () => {
  const account = source.slice(source.indexOf("if (fixture.account) {", source.indexOf("fixture.approve()")), source.indexOf('await until("account connect stage"'));
  const steps = [
    'driver.text("machine-name"), value => value === systemName',
    '(await ok("name")).computer === systemName',
    'await driver.click("edit-computer-name")',
    'await driver.fill("computer-name-input", editedName)',
    'await driver.enter("computer-name-input")',
    'driver.text("machine-name"), value => value === editedName',
    '(await ok("name")).computer === editedName',
    'await lifecycle("quit")',
    'await open(); await title("This computer is connected")',
    'driver.text("machine-name"), value => value === editedName',
    '(await ok("name")).computer === editedName',
    'assert.deepEqual(login.args, ["--background"]',
    'background login never exposes a top-level window',
    'login relaunch Settings restores same connected identity',
  ];
  let offset = 0;
  for (const step of steps) {
    const found = account.indexOf(step, offset);
    assert.ok(found >= offset, `ordered acceptance step: ${step}`);
    offset = found + step.length;
  }
  assert.equal(account.match(/process\.platform === "linux" && driver instanceof WindowDriver \? driver\.textContent\("machine-name"\) : driver\.text\("machine-name"\)/g)?.length, 3);
  assert.match(account, /systemName = hostname\(\)/);
  assert.match(account, /\["ComputerName", "LocalHostName"\]/);
});

test("DOM name reader only reads textContent from one visible stable ID", async () => {
  const { stripTypeScriptTypes } = await import("node:module");
  const code = stripTypeScriptTypes(readFileSync(new URL("./webdriver.ts", import.meta.url), "utf8"), { mode: "transform" });
  const { WindowDriver } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const driver = new WindowDriver();
  driver.session = "test";
  let matches = [{ checkVisibility: () => true, textContent: "Real computer" }];
  let calls = 0;
  driver.call = async (method, path, body) => {
    calls++;
    assert.equal(method, "POST");
    assert.equal(path, "/session/test/execute/sync");
    assert.deepEqual(body.args, ["machine-name"]);
    const document = { querySelectorAll(selector) { assert.equal(selector, "#machine-name"); return matches; } };
    return new Function("document", `return function(){${body.script}}`)(document)(...body.args);
  };
  assert.equal(await driver.textContent("machine-name"), "Real computer");
  const visible = matches[0];
  matches = [];
  await assert.rejects(driver.textContent("machine-name"), /must name one element/);
  matches = [visible, visible];
  await assert.rejects(driver.textContent("machine-name"), /must name one element/);
  matches = [{ checkVisibility: () => false, get textContent() { assert.fail("hidden text must not be read"); } }];
  await assert.rejects(driver.textContent("machine-name"), /must be visible/);
  await assert.rejects(driver.textContent("machine-name, input"));
  assert.equal(calls, 4, "invalid stable ID never reaches script execution");
});

test("name Enter drivers send native keys rather than script form submission", () => {
  const webdriver = readFileSync(new URL("./webdriver.ts", import.meta.url), "utf8");
  const mac = readFileSync(new URL("./macos-driver.ts", import.meta.url), "utf8");
  const swift = readFileSync(new URL("./macos-driver.swift", import.meta.url), "utf8");
  assert.match(webdriver, /async enter\(id: string\)[\s\S]*?element\/\$\{await this.element\(id\)\}\/value[\s\S]*?text: "\\uE007"/);
  assert.match(mac, /async enter\(id: string\).*this.command\("enter", id\)/);
  assert.ok(swift.includes('case "enter":\n    press(unique(matches(arg(0))))\n    key(36)'));
});
