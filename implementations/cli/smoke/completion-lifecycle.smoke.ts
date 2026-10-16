/**
 * Completion install/uninstall lifecycle smoke test.
 * Exercises `cotal completion install` and `cotal completion uninstall` in isolated temporary environments.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completion, completionComplete } from "../src/commands/completion.js";

let passed = 0;
let failed = 0;

function check(label: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.error(`✗ ${label}`);
  }
}

const originalHome = process.env.HOME;
const originalXdg = process.env.XDG_CONFIG_HOME;
const originalZdotdir = process.env.ZDOTDIR;
const originalShell = process.env.SHELL;

const tempDir = mkdtempSync(join(tmpdir(), "cotal-completion-smoke-"));

try {
  process.env.HOME = tempDir;
  process.env.XDG_CONFIG_HOME = join(tempDir, ".config");
  process.env.ZDOTDIR = tempDir;
  process.env.SHELL = "/bin/bash";

  // 1. CompletionComplete tests
  const initialCompletion = completionComplete([""]);
  check(
    "completionComplete offers install and uninstall",
    initialCompletion.items.some((i) => i.value === "install") &&
      initialCompletion.items.some((i) => i.value === "uninstall"),
  );

  const uninstallSubCompletion = completionComplete(["uninstall", ""]);
  check(
    "completionComplete uninstall offers supported shells",
    uninstallSubCompletion.items.some((i) => i.value === "bash") &&
      uninstallSubCompletion.items.some((i) => i.value === "zsh") &&
      uninstallSubCompletion.items.some((i) => i.value === "fish"),
  );

  // 2. Bash install and uninstall
  const bashrc = join(tempDir, ".bashrc");
  const bashStub = join(tempDir, ".config", "cotal", "completion.bash");
  writeFileSync(bashrc, "# existing bashrc\nexport FOO=1\n");

  await completion({ values: {}, positionals: ["install", "bash"], raw: ["install", "bash"] });
  check("bash install creates completion.bash", existsSync(bashStub));
  const bashrcAfterInstall = readFileSync(bashrc, "utf8");
  check("bash install appends to .bashrc", bashrcAfterInstall.includes(`source "${bashStub}"`));

  // Idempotent install
  await completion({ values: {}, positionals: ["install", "bash"], raw: ["install", "bash"] });
  const bashrcAfterSecondInstall = readFileSync(bashrc, "utf8");
  const bashMatches = (
    bashrcAfterSecondInstall.match(new RegExp(`source "${bashStub.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g")) || []
  ).length;
  check("bash install is idempotent (source line appears once)", bashMatches === 1);

  // Bash uninstall
  await completion({ values: {}, positionals: ["uninstall", "bash"], raw: ["uninstall", "bash"] });
  check("bash uninstall removes completion.bash stub", !existsSync(bashStub));
  const bashrcAfterUninstall = readFileSync(bashrc, "utf8");
  check("bash uninstall removes source line from .bashrc", !bashrcAfterUninstall.includes(bashStub));
  check("bash uninstall preserves rest of .bashrc", bashrcAfterUninstall.includes("export FOO=1"));

  // Idempotent uninstall
  await completion({ values: {}, positionals: ["uninstall", "bash"], raw: ["uninstall", "bash"] });
  check("bash uninstall is idempotent", !existsSync(bashStub));

  // 3. Zsh install and uninstall
  const zshrc = join(tempDir, ".zshrc");
  const zshStub = join(tempDir, ".config", "cotal", "completion.zsh");
  writeFileSync(zshrc, "# existing zshrc\nexport BAR=2\n");

  await completion({ values: {}, positionals: ["install", "zsh"], raw: ["install", "zsh"] });
  check("zsh install creates completion.zsh", existsSync(zshStub));
  const zshrcAfterInstall = readFileSync(zshrc, "utf8");
  check("zsh install appends to .zshrc", zshrcAfterInstall.includes(`source "${zshStub}"`));

  await completion({ values: {}, positionals: ["uninstall", "zsh"], raw: ["uninstall", "zsh"] });
  check("zsh uninstall removes completion.zsh stub", !existsSync(zshStub));
  const zshrcAfterUninstall = readFileSync(zshrc, "utf8");
  check("zsh uninstall removes source line from .zshrc", !zshrcAfterUninstall.includes(zshStub));
  check("zsh uninstall preserves rest of .zshrc", zshrcAfterUninstall.includes("export BAR=2"));

  // 4. Fish install and uninstall
  const fishFile = join(tempDir, ".config", "fish", "completions", "cotal.fish");

  await completion({ values: {}, positionals: ["install", "fish"], raw: ["install", "fish"] });
  check("fish install creates cotal.fish", existsSync(fishFile));

  await completion({ values: {}, positionals: ["uninstall", "fish"], raw: ["uninstall", "fish"] });
  check("fish uninstall removes cotal.fish", !existsSync(fishFile));

  // Idempotent fish uninstall
  await completion({ values: {}, positionals: ["uninstall", "fish"], raw: ["uninstall", "fish"] });
  check("fish uninstall is idempotent", !existsSync(fishFile));
} finally {
  process.env.HOME = originalHome;
  process.env.XDG_CONFIG_HOME = originalXdg;
  process.env.ZDOTDIR = originalZdotdir;
  process.env.SHELL = originalShell;
  rmSync(tempDir, { recursive: true, force: true });
}

console.log(`COTAL_SMOKE_SENTINEL cells=${passed + failed} passed=${passed} failed=${failed}`);
process.exit(failed ? 1 : 0);
