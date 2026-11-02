/** Exercise actual catch logging statements with Node's console, without running or editing their scenarios. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const sources = [
  "bin/smoke/backup-usermode-live.smoke.ts",
  "implementations/auth/smoke/admission-mediator.smoke.ts",
  "implementations/auth/smoke/callout-deny.smoke.ts",
  "implementations/auth/smoke/credential-ledger.smoke.ts",
  "implementations/auth/smoke/ctl-trust.smoke.ts",
  "implementations/auth/smoke/endpoint-usermode.smoke.ts",
  "implementations/auth/smoke/expiry-renewal.smoke.ts",
  "implementations/auth/smoke/freeslot-respawn-barrier.smoke.ts",
  "implementations/auth/smoke/int2-revoke-hold.smoke.ts",
  "implementations/auth/smoke/mediator-confinement.smoke.ts",
  "implementations/auth/smoke/retirement-barrier.smoke.ts",
  "implementations/auth/smoke/user-auth-launch.smoke.ts",
  "implementations/auth/smoke/user-spawn.smoke.ts",
  "implementations/cli/smoke/console-attach.smoke.ts",
  "implementations/cli/smoke/console-control.smoke.ts",
  "implementations/cli/smoke/console-gaps.smoke.ts",
  "implementations/cli/smoke/console-participant.smoke.ts",
  "implementations/delivery/smoke/sys-injection-evict.smoke.ts",
  "implementations/manager/smoke/boot-self-heal-gate.smoke.ts",
  "implementations/manager/smoke/events-grant-acl.smoke.ts",
  "implementations/manager/smoke/gate-reconcile-auth.smoke.ts",
  "implementations/manager/smoke/gate-reconcile-cli-e2e.smoke.ts",
  "implementations/manager/smoke/lifecycle-e2e.smoke.ts",
  "implementations/runtime/smoke/placement-grants.smoke.ts",
  "packages/core/smoke/acl-cas.smoke.ts",
  "packages/core/smoke/cross-owner-auth.smoke.ts",
  "packages/core/smoke/e2e-acl.smoke.ts",
  "packages/core/smoke/endpoint-binding.smoke.ts",
  "packages/core/smoke/endpoint-journal.smoke.ts",
  "packages/core/smoke/endpoint-publish-denial.smoke.ts",
  "packages/core/smoke/endpoint-records.smoke.ts",
  "packages/core/smoke/evict-live-auth.smoke.ts",
  "packages/core/smoke/membership-feed-confinement.smoke.ts",
  "packages/core/smoke/membership-feed.smoke.ts",
  "packages/workspace/smoke/space-auth-store.smoke.ts"
] as const;
const root = new URL("../../", import.meta.url);
const values = [
  { name: "Error", expression: 'new Error("diagnostic-control")', expected: "Error: diagnostic-control" },
  { name: "string", expression: '"diagnostic-string-control"', expected: "diagnostic-string-control" },
  { name: "null", expression: "null", expected: "null" },
  { name: "undefined", expression: "undefined", expected: "undefined" },
];
let passed = 0, failed = 0;
assert.equal(sources.length, 35);
for (const file of sources) {
  const source = readFileSync(new URL(file, root), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const statements: ts.ExpressionStatement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node)) {
      for (const statement of node.block.statements) {
        if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
        const call = statement.expression;
        if (["console.error", "console.log", "realErr"].includes(call.expression.getText(parsed))
          && call.arguments[0]?.getText(parsed).includes("threw")) {
          assert.ok(node.variableDeclaration && ts.isIdentifier(node.variableDeclaration.name));
          assert.equal(node.variableDeclaration.name.text, "e", `${file}: catch binding changed`);
          statements.push(statement);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.equal(statements.length, 1, `${file}: expected one scenario diagnostic`);
  const js = ts.transpileModule(statements[0]!.getText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  // This suite's alias preserves the original Console method before its scenario tees output.
  if (js.includes("realErr(")) assert.ok(source.includes("realErr = console.error.bind(console)"));
  for (const value of values) {
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval",
      `const realErr = console.error.bind(console); try { throw ${value.expression}; } catch (e) { ${js} }`], {
      cwd: fileURLToPath(root), encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, DO_NOT_TRACK: "1" },
    });
    assert.ifError(result.error);
    const output = `${result.stdout}${result.stderr}`;
    const ok = result.status === 0 && output.includes(value.expected)
      && (value.name !== "Error" || output.includes("    at "));
    if (ok) passed++; else failed++;
    console.log(`${ok ? "PASS" : "FAIL"} ${file}: ${value.name}`);
    if (!ok) console.log(JSON.stringify({ status: result.status, output: output.slice(0, 1200) }));
  }
}
assert.equal(passed + failed, sources.length * values.length);
emitSentinel({ cells: passed + failed, passed, failed });
process.exitCode = failed ? 1 : 0;
