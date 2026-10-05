/**
 * A Claude resume carried between hosts (docs/design/resume-transfer.md sections 7 and 10): finding
 * a session's transcript on the operator's host, and launching its fork in a seat-private config home
 * on the manager's host.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { ResumeTranscriptLocator } from "@cotal-ai/core";

/** The project directory name a carried seat's transcripts live under (`CLAUDE_CODE_PROJECT_DIR_NAME`). */
const SEAT_PROJECT = "seat";
/** The fork record a carried seat writes in its home (design section 9). */
const FORK_RECORD = "cotal-fork.json";
/** The first Claude release that honours `CLAUDE_CODE_PROJECT_DIR_NAME`. */
const MIN_VERSION = [2, 1, 234] as const;
/** The manager keeps a fork title of at most this many characters. */
const MAX_TITLE = 1024;

function configDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
}

/** The `.claude.json` Claude reads beside a config directory: inside a `CLAUDE_CONFIG_DIR`, else in HOME. */
function stateFile(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(env.HOME || homedir(), ".claude.json");
}

/** Every regular `*.jsonl` file one level under `projects/`. Linked project directories and files are
 *  skipped, so a link cycle in the tree is never followed. */
function transcripts(env: NodeJS.ProcessEnv): string[] {
  const projects = join(configDir(env), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(projects, d.name));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return dirs.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true }).filter((f) => f.isFile() && f.name.endsWith(".jsonl")).map((f) => join(dir, f.name)));
}

/** The session's name: the last title the operator gave it with `/rename`. */
function titleOf(path: string): string | undefined {
  let title: string | undefined;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") title = entry.customTitle;
    } catch {
      // A torn last line is the session still being written, not a title.
    }
  }
  return title;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export const claudeResumeTranscript: ResumeTranscriptLocator = {
  find(id, env) {
    const all = transcripts(env);
    const held = all.filter((p) => p.endsWith(`/${id}.jsonl`));
    if (held.length > 0) {
      const digests = new Set(held.map(sha256));
      if (digests.size > 1)
        throw new Error(`session ${id} is held by ${digests.size} different transcripts on this host (${held.join(", ")}); remove the stale copy`);
      const title = titleOf(held[0]);
      if (title !== undefined && title.length > MAX_TITLE)
        throw new Error(`session ${id} has a title of ${title.length} characters; a carried session's title is at most ${MAX_TITLE}`);
      return { path: held[0], ...(title ? { title } : {}) };
    }
    const named = all.filter((p) => titleOf(p) === id);
    if (named.length === 0) return undefined;
    const rows = named.map((p) => {
      const sid = p.slice(p.lastIndexOf("/") + 1, -".jsonl".length);
      return `  ${hostname()} ${sid} sha256:${sha256(p)} ${lstatSync(p).mtime.toISOString()}`;
    });
    throw new Error(`"${id}" is a session name, not a session id; resume by id:\n${rows.join("\n")}`);
  },
};

function versionAtLeast(text: string): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) if (v[i] !== MIN_VERSION[i]) return v[i] > MIN_VERSION[i];
  return true;
}

/**
 * Refuse a carried launch this host cannot run, before anything is written: a Claude that ignores
 * `CLAUDE_CODE_PROJECT_DIR_NAME`, a seat environment with no credential a fresh home can use, or a
 * working directory the manager's own Claude home does not trust.
 */
export function refuseCarriedLaunch(binary: string, seatEnv: Record<string, string>, cwd: string): void {
  const version = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (!versionAtLeast(version))
    throw new Error(`claude connector: a carried resume needs Claude ${MIN_VERSION.join(".")} or later (CLAUDE_CODE_PROJECT_DIR_NAME); this host runs ${version.trim()}`);
  const provider = Object.keys(seatEnv).some((k) => k.startsWith("CLAUDE_CODE_USE_") && seatEnv[k] !== "" && seatEnv[k] !== "0");
  if (!seatEnv.CLAUDE_CODE_OAUTH_TOKEN && !seatEnv.ANTHROPIC_AUTH_TOKEN && !provider)
    throw new Error(
      "claude connector: a carried resume runs in a seat-private Claude home that holds no login" +
        (seatEnv.ANTHROPIC_API_KEY ? ", and ANTHROPIC_API_KEY alone needs an approval that home cannot remember" : "") +
        "; run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN in the manager's environment",
    );
  let trusted = false;
  try {
    const state = JSON.parse(readFileSync(stateFile(process.env), "utf8")) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> };
    trusted = state.projects?.[cwd]?.hasTrustDialogAccepted === true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (!trusted)
    throw new Error(`claude connector: the manager's Claude home does not trust ${cwd}; open \`claude\` in that directory on the manager host once, then launch again`);
}

/** Where a carried seat writes its fork record: the manager's {@link LaunchSpec.resumeRecordPath}. */
export function carriedForkRecord(home: string): string {
  return join(home, FORK_RECORD);
}

/** Fill the seat's home: the carried transcript where `--resume` finds it, and the first-run state a
 *  fresh home would otherwise prompt for, trusting only the launch directory already checked. */
export function placeCarried(home: string, transcript: string, resume: string | undefined, cwd: string): Record<string, string> {
  writeFileSync(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [cwd]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 });
  if (resume !== undefined) {
    const dir = join(home, "projects", SEAT_PROJECT);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    copyFileSync(transcript, join(dir, `${resume}.jsonl`));
  }
  return { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_PROJECT_DIR_NAME: SEAT_PROJECT, ...(resume !== undefined ? { COTAL_CLAUDE_CARRIED: resume } : {}) };
}

/**
 * Write a carried seat's fork record once Claude has resumed: the digest of the transcript it read,
 * which the manager holds to the carried claim before it records the seat's provenance. A seat that
 * was not carried, or a session start that is not the resume, writes nothing; a later resume of the
 * same seat keeps the first record.
 */
export function recordCarriedFork(env: NodeJS.ProcessEnv, start: unknown): void {
  const source = env.COTAL_CLAUDE_CARRIED;
  if (!source || !env.CLAUDE_CONFIG_DIR || start !== "resume") return;
  const transcript = join(env.CLAUDE_CONFIG_DIR, "projects", SEAT_PROJECT, `${source}.jsonl`);
  const title = titleOf(transcript);
  try {
    writeFileSync(carriedForkRecord(env.CLAUDE_CONFIG_DIR), JSON.stringify({ source, ...(title ? { title } : {}), transcriptSha256: sha256(transcript) }), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
}
