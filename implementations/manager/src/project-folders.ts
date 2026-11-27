/**
 * The manager's `make-dir` and `clone` commands (SPEC §9): a launcher makes the folder a new
 * project starts in, under a parent directory on this host, and then spawns there. Git runs as the
 * Manager's host user with that user's own credentials and settings. Nothing in a request is a
 * credential, and git never asks anyone anything.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EpEnvelopeError, rejectionText, type EpServeContext } from "@cotal-ai/core";
import type { SeatLaunch } from "./seat-launch.js";

type ParentResolver = Pick<SeatLaunch, "resolveSpawnCwd">;
type CloneOutput = { path: string; head: string | null; ref: string | null; existing: boolean };
type GitRun = { code: number; stdout: string; stderr: string };

/** Time kept back from the caller's deadline so a refusal still reaches it. */
const REPLY_MARGIN_MS = 1_000;
const STDERR_TAIL_BYTES = 4_096;
/** user@host:path, git's scp-like ssh form. Neither user nor host may start with a dash. */
const SCP_LIKE = /^[A-Za-z0-9._~+][A-Za-z0-9._~+-]*@[A-Za-z0-9][A-Za-z0-9.-]*:(?!\/\/)(.+)$/;
/** What git and its transports print when the host's credentials cannot read the repository. */
const ACCESS_REFUSED = /could not read (Username|Password)|Authentication failed|Permission denied \(publickey|Repository not found|returned error: 40[134]/;

const refuse = (code: "bad-request" | "already-exists" | "failed-precondition", message: string): never => {
  throw new EpEnvelopeError(code, message, undefined, "not-executed");
};

function folderName(value: unknown): string {
  const name = String(value);
  if (name === "" || name === "." || name === ".." || /[/\\\0]/.test(name))
    refuse("bad-request", `${JSON.stringify(name)} is not one folder name: it must not be . or .. or contain a path separator`);
  return name;
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    return refuse("failed-precondition", `${JSON.stringify(path)} cannot be inspected on this host (${rejectionText(error)})`);
  }
}

/** Create the empty folder `name` under `parent`. An existing folder is refused, never reused. */
export async function makeProjectDirectory(args: Record<string, unknown>, launch: ParentResolver): Promise<{ path: string }> {
  const { cwd: parent } = launch.resolveSpawnCwd(args.parent);
  const target = join(parent, folderName(args.name));
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") refuse("already-exists", `${JSON.stringify(target)} already exists`);
    refuse("failed-precondition", `folder cannot be created on this host: ${JSON.stringify(target)} (${rejectionText(error)})`);
  }
  return { path: await realpath(target) };
}

/** The URL and its path, for an https or ssh URL or git's user@host:path. Anything git would read
 *  as a local path, another transport or an option is refused before git runs. */
function cloneSource(value: unknown): { url: string; path: string } {
  const url = String(value);
  const unsupported = `${JSON.stringify(url)} is not a clone URL this host accepts: use https://, ssh:// or user@host:path`;
  if (url.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(url)) refuse("bad-request", unsupported);
  const scp = SCP_LIKE.exec(url);
  if (scp) return { url, path: scp[1]! };
  let parsed: URL;
  try { parsed = new URL(url); } catch { return refuse("bad-request", unsupported); }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "ssh:") || !parsed.hostname || parsed.hostname.startsWith("-"))
    refuse("bad-request", unsupported);
  if (parsed.password) refuse("bad-request", "a clone URL must not carry a password: git uses this host's own credentials");
  return { url, path: parsed.pathname };
}

function cloneRef(value: unknown): string {
  const ref = String(value);
  if (ref.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(ref)) refuse("bad-request", `${JSON.stringify(ref)} is not a branch or tag name`);
  return ref;
}

/** The folder git itself would name a clone: the URL's last path segment without `.git`. */
function defaultName(path: string): string {
  const name = path.replace(/[/\\]+$/, "").split(/[/\\:]/).pop()!.replace(/\.git$/, "");
  if (!name) refuse("bad-request", "the URL names no folder, so the clone needs a name");
  return name;
}

/** The host's environment, with every prompt off and only the https and ssh transports allowed,
 *  including for a URL the host's own configuration rewrites. Repository discovery stops at
 *  `ceiling`, so a folder inside another repository is never taken for that repository. */
const gitEnv = (ceiling: string): NodeJS.ProcessEnv => ({
  ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never",
  GCM_INTERACTIVE: "never", GIT_ALLOW_PROTOCOL: "https:ssh", GIT_CEILING_DIRECTORIES: ceiling,
});

const deadlineExceeded = () => new EpEnvelopeError("deadline-exceeded", "the clone did not finish within the caller's deadline, and nothing was kept");

function killGroup(child: ChildProcess): void {
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid!, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/** Run git until `endsAt` (monotonic ms). It runs in its own session, so neither git nor ssh has
 *  a terminal to prompt on, and the deadline kills the transports it started too. */
function runGit(args: string[], cwd: string, ceiling: string, endsAt: number): Promise<GitRun> {
  const remaining = endsAt - performance.now();
  if (remaining <= 0) return Promise.reject(deadlineExceeded());
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env: gitEnv(ceiling), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout!.setEncoding("utf8").on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-STDERR_TAIL_BYTES); });
    child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES); });
    const timer = setTimeout(() => { timedOut = true; killGroup(child); }, remaining);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject((error as NodeJS.ErrnoException).code === "ENOENT"
        ? new EpEnvelopeError("failed-precondition", "git is not installed on this host", undefined, "not-executed") : error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(deadlineExceeded());
      else resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
  });
}

function cloneFailure(url: string, stderr: string): EpEnvelopeError {
  const said = stderr.split("\n").map((line) => line.trim()).filter(Boolean).slice(-3).join("; ") || "git exited without a message";
  if (ACCESS_REFUSED.test(stderr))
    return new EpEnvelopeError("failed-precondition", `this host's git credentials cannot read ${url}: ${said}. Check the URL, and sign in to that git host on this computer`,
      [{ kind: "ai.cotal.manager.git-access-refused" }]);
  return new EpEnvelopeError("failed-precondition", `git clone of ${url} failed: ${said}`);
}

/** The checkout at `path`: its commit, or null before the first one, and its branch, or null when
 *  detached. Discovery stops at `path`, so only a repository whose top level is `path` answers. */
async function describeCheckout(path: string, endsAt: number): Promise<Omit<CloneOutput, "existing"> | undefined> {
  const git = (...args: string[]) => runGit(["-C", path, ...args], path, dirname(path), endsAt);
  const top = await git("rev-parse", "--show-toplevel");
  if (top.code !== 0) return undefined;
  const head = await git("rev-parse", "--verify", "--quiet", "HEAD");
  const branch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
  return { path, head: head.code === 0 ? head.stdout : null, ref: branch.code === 0 ? branch.stdout : null };
}

/** An existing `target` answers as the clone only when it is a clone of `url` itself and, when a
 *  ref was asked for, is checked out at it. It is read, never changed. */
async function existingClone(target: string, url: string, ref: string | undefined, endsAt: number): Promise<CloneOutput> {
  const taken = (why: string) => refuse("already-exists", `${JSON.stringify(target)} already exists and ${why}; choose another name`);
  const path = await realpath(target);
  const checkout = await describeCheckout(path, endsAt) ?? taken("is not a git clone");
  const git = (...args: string[]) => runGit(["-C", path, ...args], path, dirname(path), endsAt);
  const origin = (await git("config", "--get", "remote.origin.url")).stdout;
  if (origin !== url) taken(`is a clone of ${origin || "no origin"}, not ${url}`);
  if (ref !== undefined) {
    const at = await git("rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`);
    if (at.code !== 0 || at.stdout !== checkout.head) taken(`is not checked out at ${ref}`);
  }
  return { ...checkout, existing: true };
}

/** The monotonic time a clone must end by: the caller's own deadline, less time to reply. */
function cloneEndsAt(ctx: EpServeContext): number {
  const { receivedAtMonotonicMs: received } = ctx, budget = ctx.request.deadlineMs;
  if (received === undefined || !Number.isFinite(received) || budget === undefined)
    refuse("bad-request", "clone is a call with a deadline");
  return received! + budget! - REPLY_MARGIN_MS;
}

/** Clone `url` into `name` under `parent`. Git writes into a hidden staging folder beside the
 *  target, which takes the name only once the clone is complete, so a failed or timed-out clone
 *  leaves nothing and a concurrent or retried clone of the same URL answers the finished one. */
export async function cloneProject(args: Record<string, unknown>, launch: ParentResolver, ctx: EpServeContext): Promise<CloneOutput> {
  const endsAt = cloneEndsAt(ctx);
  const { cwd: parent } = launch.resolveSpawnCwd(args.parent);
  const source = cloneSource(args.url);
  const ref = args.ref === undefined ? undefined : cloneRef(args.ref);
  const target = join(parent, folderName(args.name ?? defaultName(source.path)));
  if (await exists(target)) return existingClone(target, source.url, ref, endsAt);
  let staging: string;
  try { staging = await mkdtemp(join(parent, ".cotal-clone-")); }
  catch (error) { return refuse("failed-precondition", `a folder cannot be created in ${JSON.stringify(parent)} (${rejectionText(error)})`); }
  try {
    const run = await runGit(["clone", ...(ref === undefined ? [] : [`--branch=${ref}`]), "--", source.url, staging], parent, parent, endsAt);
    if (run.code !== 0) throw cloneFailure(source.url, run.stderr);
    try {
      await rename(staging, target);
    } catch (error) {
      if (!(await exists(target))) throw new EpEnvelopeError("failed-precondition", `the clone cannot be moved to ${JSON.stringify(target)} (${rejectionText(error)})`);
      return await existingClone(target, source.url, ref, endsAt);
    }
    return { ...(await describeCheckout(await realpath(target), endsAt))!, existing: false };
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3 });
  }
}
