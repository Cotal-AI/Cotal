import { spawn as spawnProcess } from "node:child_process";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { DEFAULT_SERVER, registry, type Connector } from "@cotal-ai/core";
import { findClaudeSession } from "../lib/session.js";
import { resolveSpace } from "../lib/status.js";

/**
 * `cotal resume` — late-join: bring an EXISTING Claude Code session onto the mesh.
 *
 * A live `claude` process can't be hot-attached (its MCP, hooks and wake channel are bound
 * at launch), so late-join means relaunching the session's history wired to the mesh. Unlike
 * `cotal spawn`, this needs NO agent file and runs from any directory: it discovers the newest
 * session for `--cwd` (default: where you run it), then launches `claude` there, joined to the
 * space. Two modes:
 *
 *   default     fork — `--resume <id> --fork-session`: a new id seeded with the history; the
 *               original keeps running untouched. Always safe; the mesh peer is a copy.
 *   --in-place  continue the SAME id — the true "this session is now on the mesh". Exit the
 *               original first (two live processes writing one transcript corrupts it).
 */
export async function resume(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      resume: { type: "string" }, // explicit session id; else auto-discover the newest for cwd
      cwd: { type: "string" }, // which project's session to adopt (and where claude is launched)
      "in-place": { type: "boolean" }, // continue the same id instead of forking a new one
      name: { type: "string" },
      role: { type: "string" },
      space: { type: "string" },
      server: { type: "string" },
      agent: { type: "string" },
    },
  });

  // The session lives under, and is resumed from, this directory — `claude --resume <id>` only
  // resolves an id within its own project (cwd), so we both discover and launch there.
  const cwd = resolve(values.cwd ?? process.cwd());
  const sessionId = values.resume ?? findClaudeSession(cwd)?.id;
  if (!sessionId) {
    console.error(
      `✗ no Claude Code session found for ${cwd}\n` +
        `  looked in ~/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}/\n` +
        `  pass --resume <id>, or --cwd <project-dir> to point at another project`,
    );
    process.exit(1);
  }

  const fork = !values["in-place"];
  const name = values.name ?? userInfo().username;
  const role = values.role;
  const space = values.space ?? resolveSpace(cwd);
  const server = values.server ?? DEFAULT_SERVER;

  const connector = registry.resolve<Connector>("connector", values.agent ?? "claude");
  const spec = connector.buildLaunch({ space, name, role, servers: server, resume: sessionId, fork });

  console.error(
    `resuming ${name} into ${space} ${fork ? "(fork)" : "(in place — exit the original first)"} ` +
      `— session ${sessionId.slice(0, 8)} — press Enter at the dev-channels prompt`,
  );
  const child = spawnProcess(spec.command, spec.args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...spec.env },
  });
  await new Promise<void>((res) => {
    child.on("error", (e) => {
      console.error(`✗ failed to launch ${spec.command}: ${e.message}`);
      process.exitCode = 1;
      res();
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      res();
    });
  });
}
