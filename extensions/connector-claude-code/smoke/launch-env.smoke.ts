/**
 * Claude seat env: the documented auth vars must reach the child; host-session markers must not.
 *
 * THE BLOCKER THIS GRADES. After launchEnv stopped inheriting, CLAUDE_CODE_OAUTH_TOKEN (the name
 * docs/deploy.md and deploy/ tell operators a container Claude authenticates with) was silently
 * absent: this connector called launchEnv with no providerKeys. A container has no Keychain, so
 * the seat boots and then cannot reach Anthropic. That is the fallback failure mode an allowlist
 * must not have: dropping a credential the docs promise.
 *
 * THE LIST IS NOT "every CLAUDE_CODE_*". CLAUDE_CODE_CHILD_SESSION / CLAUDECODE /
 * CLAUDE_CODE_ENTRYPOINT stay withheld — those are how a nested `claude` decides it must not
 * save a transcript, which is the defect #866 closed. The cells below name both sides so a
 * prefix-forward of CLAUDE_CODE_* cannot pass as a fix.
 *
 * SPECIFIER BOUNDARY. The suite imports the connector by relative source path
 * (`../src/extension.js`) and calls buildLaunch directly: no dist in the path, no build in the
 * command. Mutation-proof can therefore grade src/extension.ts without a rebuild.
 *
 * Run: pnpm smoke:claude-launch-env
 */
import { claudeConnector, CLAUDE_PROVIDER_KEYS } from "../src/extension.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const HOST_MARKERS = ["CLAUDE_CODE_CHILD_SESSION", "CLAUDE_CODE_ENTRYPOINT", "CLAUDECODE"] as const;
const UNRELATED = ["GH_TOKEN", "P3_OPERATOR_SECRET", "SOME_UNRELATED_SECRET"] as const;

for (const k of CLAUDE_PROVIDER_KEYS) process.env[k] = `smoke-${k}`;
for (const k of HOST_MARKERS) process.env[k] = `parent-${k}`;
for (const k of UNRELATED) process.env[k] = `parent-${k}`;

const env = claudeConnector.buildLaunch({ space: "smoke", name: "claude-1" } as never).env ?? {};

check(
  "CLAUDE_CODE_OAUTH_TOKEN reached the child",
  env.CLAUDE_CODE_OAUTH_TOKEN === "smoke-CLAUDE_CODE_OAUTH_TOKEN",
  env.CLAUDE_CODE_OAUTH_TOKEN,
);
check(
  "ANTHROPIC_API_KEY reached the child",
  env.ANTHROPIC_API_KEY === "smoke-ANTHROPIC_API_KEY",
  env.ANTHROPIC_API_KEY,
);
check(
  "ANTHROPIC_AUTH_TOKEN reached the child",
  env.ANTHROPIC_AUTH_TOKEN === "smoke-ANTHROPIC_AUTH_TOKEN",
  env.ANTHROPIC_AUTH_TOKEN,
);
check(
  "CLAUDE_CODE_USE_BEDROCK reached the child",
  env.CLAUDE_CODE_USE_BEDROCK === "smoke-CLAUDE_CODE_USE_BEDROCK",
  env.CLAUDE_CODE_USE_BEDROCK,
);

for (const k of CLAUDE_PROVIDER_KEYS) {
  check(`${k} is on CLAUDE_PROVIDER_KEYS and crossed`, env[k] === `smoke-${k}`, env[k]);
}

const leakedMarkers = HOST_MARKERS.filter((k) => k in env);
check("Claude host-session markers were withheld", leakedMarkers.length === 0, leakedMarkers);

for (const k of UNRELATED) {
  check(`${k} was withheld (not a declared auth var)`, !(k in env));
}

// PATH reaches the child under either spelling. Windows env names are case-insensitive but keep
// their source casing, so a host spelling `Path` must forward as `Path` and one spelling `PATH` must
// forward as `PATH` — exactly once each, never both, since a case-duplicate chokes Windows process
// creation. Both rows run on every platform on purpose: fixturing one spelling leaves the other free
// to regress unseen, and asserting only `env.PATH` is how the `Path` failure (#1141) reached CI.
const ambientPath = process.env.PATH ?? process.env.Path ?? "";
check("the ambient PATH fixture is non-empty, so the rows below can discriminate", ambientPath.length > 0);
for (const spelling of ["PATH", "Path"] as const) {
  delete process.env.PATH;
  delete process.env.Path;
  process.env[spelling] = ambientPath;
  const row =
    claudeConnector.buildLaunch({ space: "smoke", name: `claude-path-${spelling}` } as never).env ?? {};
  const forwarded = Object.keys(row).filter((k) => k.toLowerCase() === "path");
  check(
    `a host spelling of ${spelling} is forwarded exactly once, keeping its source casing`,
    forwarded.length === 1 && forwarded[0] === spelling,
    forwarded,
  );
  check(`${spelling} reaches the child with its value unchanged`, row[spelling] === ambientPath, row[spelling]);
}
delete process.env.Path;
process.env.PATH = ambientPath;

const opted = claudeConnector.buildLaunch({
  space: "smoke",
  name: "claude-2",
  envAllow: ["CLAUDE_CODE_CHILD_SESSION"],
} as never).env ?? {};
check(
  "a host marker named on spawn.env is the explicit opt-in",
  opted.CLAUDE_CODE_CHILD_SESSION === "parent-CLAUDE_CODE_CHILD_SESSION",
  opted.CLAUDE_CODE_CHILD_SESSION,
);
check("an unnamed host marker stays withheld even when a sibling is opted in", !("CLAUDECODE" in opted));
check(
  "opt-in does not drop CLAUDE_CODE_OAUTH_TOKEN",
  opted.CLAUDE_CODE_OAUTH_TOKEN === "smoke-CLAUDE_CODE_OAUTH_TOKEN",
);

if (fail) {
  console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`SUITE COMPLETE: ${pass} passed, 0 failed`);
