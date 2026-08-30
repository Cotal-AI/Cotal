#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://api.github.com";

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value, file, key) {
  if (!Array.isArray(value) || value.length === 0 || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${file}: pull_request ${key} must be a non-empty string array`);
  }
  return value;
}

function pullRequestConfig(file, on) {
  if (typeof on === "string") {
    if (on.length === 0) throw new Error(`${file}: top-level on event must not be empty`);
    return on === "pull_request" ? null : undefined;
  }
  if (Array.isArray(on)) {
    if (on.length === 0) throw new Error(`${file}: top-level on sequence must not be empty`);
    if (on.some((event) => typeof event !== "string" || event.length === 0)) throw new Error(`${file}: top-level on sequence must contain only non-empty event names`);
    return on.includes("pull_request") ? null : undefined;
  }
  if (!plainObject(on)) throw new Error(`${file}: top-level on declaration must name one or more events`);
  const events = Object.keys(on);
  if (events.length === 0) throw new Error(`${file}: top-level on mapping must not be empty`);
  return Object.hasOwn(on, "pull_request") ? on.pull_request : undefined;
}

function pullRequestDeclaration(file, text) {
  const document = parseDocument(text, {
    logLevel: "error",
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
  });
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem) throw new Error(`${file}: invalid YAML: ${problem.message}`);
  const workflow = document.toJS({ maxAliasCount: 100 });
  if (!plainObject(workflow)) throw new Error(`${file}: workflow document must be a mapping`);
  if (!Object.hasOwn(workflow, "on")) throw new Error(`${file}: missing top-level on declaration`);
  const pullRequest = pullRequestConfig(file, workflow.on);
  if (pullRequest === undefined) return undefined;
  if (typeof workflow.name !== "string" || workflow.name.trim() === "") {
    throw new Error(`${file}: a pull-request workflow must declare a non-empty top-level name`);
  }
  if (pullRequest === null) return { file, name: workflow.name, paths: undefined, pathsIgnore: undefined };
  if (!plainObject(pullRequest)) throw new Error(`${file}: pull_request declaration must be a mapping or null`);
  const unsupported = Object.keys(pullRequest).filter((key) => key !== "paths" && key !== "paths-ignore");
  if (unsupported.length) throw new Error(`${file}: unsupported pull_request filter: ${unsupported.join(", ")}`);
  const paths = pullRequest.paths === undefined ? undefined : stringList(pullRequest.paths, file, "paths");
  const pathsIgnore = pullRequest["paths-ignore"] === undefined
    ? undefined
    : stringList(pullRequest["paths-ignore"], file, "paths-ignore");
  if (paths && pathsIgnore) throw new Error(`${file}: pull_request cannot declare both paths and paths-ignore`);
  return { file, name: workflow.name, paths, pathsIgnore };
}

function globRegex(pattern) {
  if (/[\\[\]{}()+|]/.test(pattern)) throw new Error(`unsupported workflow path pattern: ${pattern}`);
  let out = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i += 1;
        if (pattern[i + 1] === "/") { i += 1; out += "(?:.*/)?"; }
        else out += ".*";
      } else out += "[^/]*";
    } else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`${out}$`);
}

function matchesPatterns(path, patterns) {
  let matched = false;
  for (const raw of patterns) {
    const negative = raw.startsWith("!");
    const pattern = negative ? raw.slice(1) : raw;
    if (!pattern) throw new Error("empty workflow path filter");
    if (globRegex(pattern).test(path)) matched = !negative;
  }
  return matched;
}

export function expectedPullRequestWorkflows(workflows, changedPaths) {
  if (!Array.isArray(changedPaths)) throw new Error("changed paths must be an array");
  const declarations = Object.entries(workflows)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, text]) => pullRequestDeclaration(file, text))
    .filter(Boolean);
  const names = new Set();
  for (const declaration of declarations) {
    let applies = true;
    if (declaration.paths) applies = changedPaths.some((path) => matchesPatterns(path, declaration.paths));
    if (declaration.pathsIgnore) applies = changedPaths.some((path) => !matchesPatterns(path, declaration.pathsIgnore));
    if (!applies) continue;
    if (names.has(declaration.name)) throw new Error(`duplicate pull-request workflow name: ${declaration.name}`);
    names.add(declaration.name);
  }
  return [...names].sort();
}

function newestRun(runs) {
  return [...runs].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")) || Number(b.id ?? 0) - Number(a.id ?? 0))[0];
}

export function classifyPullRequestHead({ pr, headSha, expected, runs }) {
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`invalid pull request number: ${pr}`);
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`head must be a full 40-character SHA: ${headSha}`);
  const relevant = runs.filter((run) =>
    run.event === "pull_request" &&
    run.head_sha === headSha &&
    Array.isArray(run.pull_requests) &&
    run.pull_requests.some((pull) => pull.number === pr),
  );
  const missing = [], pending = [], failing = [];
  for (const name of expected) {
    const candidates = relevant.filter((run) => run.name === name);
    if (candidates.length === 0) { missing.push(name); continue; }
    const run = newestRun(candidates);
    if (run.status !== "completed") { pending.push(name); continue; }
    if (run.conclusion !== "success") failing.push(name);
  }
  return { expected, missing, pending, failing, green: missing.length === 0 && pending.length === 0 && failing.length === 0 };
}

function authHeaders() {
  let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    try { token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
    catch { token = undefined; }
  }
  return {
    accept: "application/vnd.github+json",
    "user-agent": "cotal-pr-head-gate",
    "x-github-api-version": "2022-11-28",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function api(path, query = {}) {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: authHeaders() });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url.pathname}: ${await response.text()}`);
  return response.json();
}

async function rawApi(path, query = {}) {
  const url = new URL(path, API);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { ...authHeaders(), accept: "application/vnd.github.raw+json" } });
  if (!response.ok) throw new Error(`GitHub API ${response.status} for ${url.pathname}: ${await response.text()}`);
  return response.text();
}

async function pages(path, query = {}) {
  const out = [];
  for (let page = 1; ; page++) {
    const batch = await api(path, { ...query, per_page: 100, page });
    if (!Array.isArray(batch)) throw new Error(`${path}: expected an array response`);
    out.push(...batch);
    if (batch.length < 100) return out;
    if (page === 30) throw new Error(`${path}: exceeds GitHub's 3000-file pagination limit`);
  }
}

function repository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const remote = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
  const match = remote.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`cannot derive GitHub repository from origin: ${remote}`);
  return `${match[1]}/${match[2]}`;
}

async function live(pr) {
  const repo = repository();
  const pull = await api(`/repos/${repo}/pulls/${pr}`);
  const headSha = pull.head?.sha;
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`PR #${pr} returned an invalid head SHA`);
  const files = await pages(`/repos/${repo}/pulls/${pr}/files`);
  const changedPaths = files.flatMap((file) => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  const entries = await api(`/repos/${repo}/contents/.github/workflows`, { ref: headSha });
  if (!Array.isArray(entries)) throw new Error("workflow directory response is malformed");
  const workflowEntries = entries.filter((entry) => entry.type === "file" && /\.ya?ml$/.test(entry.name));
  const workflows = Object.fromEntries(await Promise.all(workflowEntries.map(async (entry) => [
    entry.name,
    await rawApi(`/repos/${repo}/contents/${entry.path}`, { ref: headSha }),
  ])));
  const expected = expectedPullRequestWorkflows(workflows, changedPaths);
  if (expected.length === 0) throw new Error("repository declarations yielded zero expected pull-request workflows");
  const runs = [];
  for (let page = 1; ; page++) {
    const runResponse = await api(`/repos/${repo}/actions/runs`, { head_sha: headSha, per_page: 100, page });
    if (!Array.isArray(runResponse.workflow_runs)) throw new Error("workflow-runs response is malformed");
    runs.push(...runResponse.workflow_runs);
    if (runResponse.workflow_runs.length < 100) break;
    if (page === 10) throw new Error("exact head exceeds GitHub's 1000-run filtered search limit");
  }
  return { repo, pr, headSha, ...classifyPullRequestHead({ pr, headSha, expected, runs }) };
}

function printResult(result) {
  console.log(`PR #${result.pr} exact head ${result.headSha}`);
  console.log(`expected: ${result.expected.join(", ")}`);
  if (result.missing.length) console.log(`missing: ${result.missing.join(", ")}`);
  if (result.pending.length) console.log(`pending: ${result.pending.join(", ")}`);
  if (result.failing.length) console.log(`failing: ${result.failing.join(", ")}`);
  console.log(`verdict: ${result.green ? "GREEN" : "NOT GREEN"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const raw = process.argv[2];
  if (!/^\d+$/.test(raw ?? "")) {
    console.error("usage: pnpm pr-head-gate <pull-request-number>");
    process.exitCode = 2;
  } else {
    live(Number(raw)).then((result) => {
      printResult(result);
      if (!result.green) process.exitCode = 1;
    }).catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    });
  }
}
