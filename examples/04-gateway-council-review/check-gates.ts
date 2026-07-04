#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Check = { id: string; status: "pass" | "fail" | "warn"; summary: string; evidence?: string };

const root = import.meta.dir;
const target = join(root, "target");

function read(rel: string): string {
  return readFileSync(join(target, rel), "utf8");
}

function includes(rel: string, needle: string): boolean {
  return read(rel).includes(needle);
}

function command(id: string, cmd: string, args: string[], cwd = target): Check {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
  return { id, status: result.status === 0 ? "pass" : "fail", summary: `${cmd} ${args.join(" ")}`, evidence: output.slice(-2000) };
}

function staticCheck(id: string, ok: boolean, summary: string, evidence: string): Check {
  return { id, status: ok ? "pass" : "fail", summary, evidence };
}

function warnCheck(id: string, ok: boolean, summary: string, evidence: string): Check {
  return { id, status: ok ? "pass" : "warn", summary, evidence };
}

const files = ["server.ts", "auth.ts", "ratelimit.ts", "keys.ts", "keys.sql", "bundle.ts", "README.md", "run.sh"];
const checks: Check[] = [];

for (const file of files) checks.push(staticCheck(`file:${file}`, existsSync(join(target, file)), `${file} exists`, join(target, file)));

checks.push(command("typecheck", "bunx", ["tsc", "--noEmit"]));
checks.push(staticCheck("route:auth-token", includes("server.ts", 'url.pathname === "/auth/token"'), "auth token route is present", "target/server.ts should expose POST /auth/token"));
checks.push(staticCheck("route:llm-rate-limited", includes("server.ts", "allowUser(s.userId)"), "LLM route calls per-user limiter", "target/server.ts should call allowUser before provider use"));
checks.push(warnCheck("route:auth-ip-limited", includes("server.ts", "allowIp("), "auth token route should call IP limiter", "allowIp is exported in ratelimit.ts, but server.ts should call it on /auth/token"));
checks.push(warnCheck("limiter:redis-error-fail-closed", !includes("ratelimit.ts", "return true;\n  }\n}"), "Redis errors should not fail open", "target/ratelimit.ts catch path currently allows requests if it returns true"));
checks.push(warnCheck("keys:not-plaintext-columns", !includes("keys.sql", "openai_key     TEXT") && !includes("keys.sql", "anthropic_key  TEXT"), "BYO provider keys should not be raw TEXT secrets", "target/keys.sql stores openai_key and anthropic_key as TEXT"));
checks.push(warnCheck("tokens:not-raw-map-key", !includes("auth.ts", "const tokens = new Map<string, Session>()"), "server-side token store should not use raw bearer tokens as keys", "target/auth.ts Map key is the raw bearer token"));
checks.push(warnCheck("bundle:not-derived-from-token", !includes("auth.ts", "createHash(\"sha256\").update(token).digest()"), "bundle decryption key should not be directly derivable from caller token", "target/auth.ts derives bundle key from sha256(token), so the client holder can derive it"));

const targetTs = ["server.ts", "auth.ts", "ratelimit.ts", "keys.ts", "bundle.ts"].map(read).join("\n");
checks.push(warnCheck("permissions:env-flags-wired", targetTs.includes("AGENTGW_AUTONOMOUS") || targetTs.includes("AGENTGW_ENV"), "runner permission flags should be read by TypeScript code", "target/run.sh sets AGENTGW_AUTONOMOUS and mentions AGENTGW_ENV, but target/*.ts should enforce them"));

console.log(JSON.stringify({ generatedAt: new Date().toISOString(), target, counts: { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length }, checks }, null, 2));
