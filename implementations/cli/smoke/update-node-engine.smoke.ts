import "./update-isolation.js";
import rawAssert from "node:assert/strict";
import { countedAssert, emitSentinel } from "@cotal-ai/smoke-kit";
import { executeUpdate, updateRuntime, type UpdateRuntime } from "../src/commands/update.js";

const counted = countedAssert(rawAssert);
const assert: typeof rawAssert = counted.assert;
const node = process.versions.node;
for (const [engines, allowed] of [
  [undefined, true], [{}, true], [{ node: "*" }, true], [{ node: `>=${node}` }, true],
  [{ node: `<${node} || >=${node}` }, true], [{ node: `>${node}` }, false],
  [{ node: `<${node}` }, false], [{ node: "not a range" }, false],
  [{ node: 22 }, false], [null, false], [[], false],
] as const) {
  for (const staged of [false, true]) {
    const events: string[] = [], errors: string[] = [];
    const rt: UpdateRuntime = {
      ...updateRuntime, env: {}, version: () => "0.13.1",
      preflightReplacement: async () => {},
      reportRunningManager: async () => "none",
      extensions: () => [], installPrefix: () => undefined,
      npm: args => ({ status: 0, stdout: args[0] === "view" ? '"0.13.2"' : "/global/node_modules", stderr: "" }),
      npmAsync: async args => {
        events.push(args.join(" "));
        if (args[0] === "cache") return { status: 0, stdout: "", stderr: "" };
        const spec = args[1], at = spec.lastIndexOf("@");
        return { status: 0, stderr: "", stdout: JSON.stringify({ name: spec.slice(0, at), version: spec.slice(at + 1),
          ...(spec.endsWith("@0.13.2") && engines !== undefined ? { engines } : {}),
          dist: { tarball: "https://registry.example/package.tgz", integrity: "sha512-fixture" } }) };
      },
      claimGlobalUpdate: () => { events.push("installation-boundary"); throw new Error("stop at installation boundary"); },
      ...(staged ? { prepareExecution: async () => { throw new Error("must not stage packages in this test"); } } : {}),
      out: () => {}, err: text => { errors.push(text); },
    };
    assert.equal(await executeUpdate(true, rt), 1);
    assert.equal(events.includes("installation-boundary"), allowed, JSON.stringify({ engines, staged }));
    if (!allowed) {
      assert.ok(!events.some(event => event.startsWith("cache add")), "incompatible or invalid requirements refuse before downloading archives");
      assert.match(errors.join("\n"), /requires Node\.js|invalid engines/);
      if (engines && "node" in engines && typeof engines.node === "string" && engines.node !== "not a range") {
        assert.ok(errors.join("\n").includes(process.version));
        assert.doesNotMatch(errors.join("\n"), /still reaching the registry|again in a few minutes/);
      }
    }
  }
}
emitSentinel({ passed: counted.cells(), failed: 0 });
