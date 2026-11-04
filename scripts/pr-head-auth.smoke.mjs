/** Test shipped credential resolution using native gh and an offline HTTP fixture. */
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSuite } from "../bin/smoke/sentinel.mjs";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "pr-head-auth-"));
const tool = fileURLToPath(new URL("pr-head-gate.mjs", import.meta.url));
const preload = fileURLToPath(new URL("../bin/smoke/fixtures/pr-head-gate-auth-fetch.mjs", import.meta.url));
const tokens = { gh: "fixture-gh-token", github: "fixture-github-token", config: "fixture-native-gh-token" };
const cases = [
  { name: "GH_TOKEN", env: { GH_TOKEN: tokens.gh }, token: tokens.gh, calls: 0 },
  { name: "GITHUB_TOKEN", env: { GITHUB_TOKEN: tokens.github }, token: tokens.github, calls: 0 },
  { name: "GH_TOKEN takes precedence", env: { GH_TOKEN: tokens.gh, GITHUB_TOKEN: tokens.github }, token: tokens.gh, calls: 0 },
  { name: "empty GH_TOKEN uses GITHUB_TOKEN", env: { GH_TOKEN: "", GITHUB_TOKEN: tokens.github }, token: tokens.github, calls: 0 },
  { name: "native gh config", config: true, token: tokens.config, calls: 1 },
  { name: "logged out native gh", calls: 1 },
  { name: "logged out before private repository", calls: 1, private: true },
  { name: "gh executable absent", calls: 1, noGh: true },
  { name: "blank explicit token", env: { GH_TOKEN: "   " }, calls: 0 },
  { name: "private repository with env token", env: { GH_TOKEN: tokens.gh }, token: tokens.gh, calls: 0, private: true },
];
try {
  check("native gh is available", execFileSync("gh", ["--version"], { encoding: "utf8" }).startsWith("gh version "));
  for (const [index, c] of cases.entries()) {
    const home = join(root, String(index));
    const gh = join(home, "gh");
    mkdirSync(gh, { recursive: true, mode: 0o700 });
    if (c.config) writeFileSync(join(gh, "hosts.yml"), `github.com:\n    user: fixture\n    oauth_token: ${tokens.config}\n    git_protocol: https\n`, { mode: 0o600 });
    const resultPath = join(home, "observed.json");
    const env = {
      PATH: c.noGh ? home : process.env.PATH, HOME: home, USERPROFILE: home,
      XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
      GH_CONFIG_DIR: gh, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0",
      GITHUB_REPOSITORY: "Cotal-AI/Cotal", PR_HEAD_GATE_FIXTURE: "success",
      PR_HEAD_GATE_AUTH_RESULT: resultPath, PR_HEAD_GATE_EXPECT_TOKEN: c.token ?? "none",
      PR_HEAD_GATE_AUTH_404: c.private ? "1" : "0", ...c.env,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const result = spawnSync(process.execPath, ["--import", preload, tool, "1098"], { cwd: home, env, encoding: "utf8", timeout: 30_000 });
    const observed = JSON.parse(readFileSync(resultPath, "utf8"));
    const output = result.stdout + result.stderr;
    const detail = { status: result.status, ghCalls: observed.ghCalls, requests: observed.requests.length };
    check(`${c.name}: credential source resolved once`, observed.ghCalls === c.calls, detail);
    if (c.token) {
      check(`${c.name}: shipped command retains green fixture verdict`, result.status === 0 && output.includes("verdict: GREEN"), detail);
      check(`${c.name}: all five requests use selected token`, observed.requests.length === 5 && observed.requests.every((r) => r.authorized && r.expectedToken), detail);
      check(`${c.name}: raw workflow request keeps its media type`, observed.requests.filter((r) => r.raw).length === 1, detail);
    } else {
      check(`${c.name}: refuses with actionable credential diagnostic`, result.status === 2 && output.includes("pr-head-gate needs a GitHub token (GH_TOKEN, GITHUB_TOKEN or gh auth login)"), detail);
      check(`${c.name}: refuses before any request`, observed.requests.length === 0, detail);
    }
    check(`${c.name}: no token value printed`, Object.values(tokens).every((token) => !output.includes(token)));
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish();
