import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { withDeadline } from "../../cli/src/commands/agents.js";

const cell = "the deadline probe stays alive until the bound fires";

if (process.argv.includes("--child")) {
  const started = Date.now();
  const result = await withDeadline(new Promise<boolean>(() => {}), 100);
  console.log(`deadline-result=${result} elapsed-ms=${Date.now() - started}`);
} else {
  const child = spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), "--child"], {
    encoding: "utf8",
    timeout: 10_000,
  });
  const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  const ok = child.status === 0 && /deadline-result=false elapsed-ms=\d+/.test(out);
  console.log(`  ${ok ? "✓" : "✗ FAIL:"} ${cell}${ok ? "" : ` ${JSON.stringify({ status: child.status, signal: child.signal, error: child.error?.message, out: out.slice(-500) })}`}`);
  process.exit(ok ? 0 : 1);
}
