import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registry, type ConnectorSetupProvider } from "@cotal-ai/core";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCS_URL = "https://github.com/Cotal-AI/Cotal/blob/main/docs/connect-claude.md";
const MARKETPLACE = "cotal-mesh";

function cotalHome(): string {
  if (process.env.COTAL_HOME) return process.env.COTAL_HOME;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, "Cotal");
  return join(homedir(), ".cotal");
}

function marketplaceDir(): string {
  return join(cotalHome(), "claude-plugin");
}

function materialize(name: string, root: string, assets: readonly string[], version?: string): void {
  const market = marketplaceDir();
  mkdirSync(market, { recursive: true });
  const dest = join(market, name);
  const staging = `${dest}.staging.${process.pid}`;
  const old = `${dest}.old.${process.pid}`;
  const orphans = readdirSync(market, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && (entry.name.startsWith(`${name}.old.`) || entry.name.startsWith(`${name}.staging.`)))
    .map((entry) => entry.name);
  if (!existsSync(dest)) {
    const recoverable = orphans.find((entry) => entry.startsWith(`${name}.old.`));
    if (recoverable) renameSync(join(market, recoverable), dest);
  }
  for (const entry of orphans) rmSync(join(market, entry), { recursive: true, force: true });
  let movedAside = false;
  let swapped = false;
  try {
    mkdirSync(staging, { recursive: true });
    for (const asset of assets) {
      const destination = join(staging, asset);
      mkdirSync(join(destination, ".."), { recursive: true });
      cpSync(join(root, asset), destination, { recursive: true, dereference: true });
    }
    if (version) {
      const manifestPath = join(staging, ".claude-plugin", "plugin.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
      manifest.version = version;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }
    if (existsSync(dest)) {
      renameSync(dest, old);
      movedAside = true;
    }
    renameSync(staging, dest);
    swapped = true;
    if (movedAside) rmSync(old, { recursive: true, force: true });
  } catch (error) {
    if (movedAside && !swapped && !existsSync(dest) && existsSync(old)) renameSync(old, dest);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (swapped) rmSync(old, { recursive: true, force: true });
  }
}

function command(...args: string[]): { status: number | null; output: string } {
  const result = spawnSync("claude", args, { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function writeMarketplace(): void {
  const market = marketplaceDir();
  const plugins = ["cotal", "cotal-skills"].filter((name) => existsSync(join(market, name, ".claude-plugin", "plugin.json")));
  mkdirSync(join(market, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({ name: MARKETPLACE, description: "Cotal for Claude Code", owner: { name: "Cotal" }, plugins }, null, 2) + "\n",
  );
  const add = command("plugin", "marketplace", "add", market);
  if (add.status !== 0 && !/already (?:exists|added)/i.test(add.output)) throw new Error(`plugin marketplace add failed:\n${add.output}`);
  if (/already (?:exists|added)/i.test(add.output)) {
    const update = command("plugin", "marketplace", "update", MARKETPLACE);
    if (update.status !== 0) throw new Error(`plugin marketplace update failed:\n${update.output}`);
  }
}

function verify(name: string, scope: string, expectedVersion?: string): void {
  const result = command("plugin", "list", "--json");
  if (result.status !== 0) throw new Error(`plugin list failed:\n${result.output}`);
  let entries: unknown;
  try {
    entries = JSON.parse(result.output);
  } catch {
    throw new Error(`could not parse plugin list:\n${result.output}`);
  }
  const match = Array.isArray(entries)
    ? entries.find((entry) => entry && typeof entry === "object" && (entry as { id?: unknown }).id === `${name}@${MARKETPLACE}` && (entry as { scope?: unknown }).scope === scope)
    : undefined;
  if (!match || (match as { enabled?: unknown }).enabled !== true || (match as { errors?: unknown[] }).errors?.length)
    throw new Error(`plugin ${name}@${MARKETPLACE} (${scope} scope) did not load`);
  if (expectedVersion && (match as { version?: unknown }).version !== expectedVersion)
    throw new Error(`plugin ${name}@${MARKETPLACE} loaded version ${String((match as { version?: unknown }).version)}; expected ${expectedVersion}`);
}

function install(name: string, scope: string, expectedVersion?: string): void {
  writeMarketplace();
  const result = command("plugin", "install", `${name}@${MARKETPLACE}`, "--scope", scope);
  if (result.status !== 0 && !/already installed/i.test(result.output)) throw new Error(`plugin install failed (${name}):\n${result.output}`);
  if (/already installed/i.test(result.output)) {
    const update = command("plugin", "update", `${name}@${MARKETPLACE}`, "--scope", scope);
    if (update.status !== 0) throw new Error(`plugin update failed (${name}):\n${update.output}`);
  }
  verify(name, scope, expectedVersion);
}

export const claudeSetupProvider: ConnectorSetupProvider = {
  kind: "connector-setup",
  name: "claude",
  requires: ["claude"],
  connector: {
    name: "claude-plugin",
    title: "Install the Claude Code plugin",
    explain: "Lets a Claude Code session join the web and wake on peer messages.",
    context: [DOCS_URL],
    run() {
      for (const asset of ["dist/mcp.cjs", "dist/hook.cjs", ".claude-plugin/plugin.json", ".mcp.json", "hooks/hooks.json"])
        if (!existsSync(join(PACKAGE_ROOT, asset))) throw new Error(`plugin asset missing: ${join(PACKAGE_ROOT, asset)}`);
      materialize("cotal", PACKAGE_ROOT, [".claude-plugin", ".mcp.json", "hooks", "dist/mcp.cjs", "dist/hook.cjs"]);
      install("cotal", "local");
      return `cotal@${MARKETPLACE} (local scope)`;
    },
  },
  skills: {
    name: "claude-skills-plugin",
    title: "Add Cotal's skills to Claude Code",
    explain: "Installs Cotal's authored skills as a Claude Code plugin.",
    context: [DOCS_URL],
    run({ skillsDir, version, stateDir }) {
      const manifestRoot = join(PACKAGE_ROOT, "skills-plugin");
      if (!existsSync(join(manifestRoot, ".claude-plugin", "plugin.json"))) throw new Error("Claude skills plugin manifest is missing");
      const payload = join(stateDir, `.claude-skills-payload.${process.pid}`);
      rmSync(payload, { recursive: true, force: true });
      try {
        mkdirSync(payload, { recursive: true });
        cpSync(join(manifestRoot, ".claude-plugin"), join(payload, ".claude-plugin"), { recursive: true, dereference: true });
        cpSync(skillsDir, join(payload, "skills"), { recursive: true, dereference: true });
        materialize("cotal-skills", payload, [".claude-plugin", "skills"], version);
        install("cotal-skills", "user", version);
        return `cotal-skills@${MARKETPLACE} (user scope)`;
      } finally {
        rmSync(payload, { recursive: true, force: true });
      }
    },
  },
};

registry.register(claudeSetupProvider);
