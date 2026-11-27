import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import type { Socket } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { darwinBootSession, darwinLaunchdJob, localPeerCredentials, processStartTime } from "@cotal-ai/seat";
import { checkDir, daemonPaths, daemonPathsFor } from "./endpoint.js";
import { launchAgentLabel } from "./install-darwin.js";
import { planUninstall } from "./install.js";
import { xmlText } from "./install-xml.js";
import { nativeRun } from "./install-native-run.js";

const launchctl = "/bin/launchctl";
const limit = 64 * 1024;
const digest = (data: string): string => createHash("sha256").update(data).digest("hex");
const refusal = (): Error => new Error("could not verify the macOS PTY host job");

interface DarwinSeatHostPlan {
  readonly root: string;
  readonly label: string;
  readonly plist: string;
  readonly argv: readonly string[];
  readonly daemonHome?: string;
  readonly bytes: string;
}

export interface DarwinSeatHostLifetime {
  readonly pid: number;
  readonly start: string;
  readonly boot: string;
}

/** Derive a job label from the hosted Manager lineage and retained execution generation. */
export function planDarwinSeatHost(input: {
  root: string;
  installation: string;
  lineage: string;
  generation: string;
  daemonHome?: string;
  argv: readonly [node: string, entry: string, ...args: string[]];
}): DarwinSeatHostPlan {
  const { root, installation, lineage, generation, daemonHome, argv } = input;
  if (![root, installation, argv[0], argv[1], ...(daemonHome === undefined ? [] : [daemonHome])].every(path => isAbsolute(path) && resolve(path) === path) ||
      !/^[a-f0-9]{64}$/.test(lineage) || !/^[a-f0-9]{64}$/.test(generation)) throw refusal();
  if (/[\u0000-\u001f\u007f]/u.test(root) || /(?:^|\/)Library\/LaunchAgents(?:\/|$)/i.test(root)) throw refusal();
  const label = `ai.cotal.pty.${digest(JSON.stringify([installation, lineage, generation])).slice(0, 32)}`;
  const args = argv.map(value => `<string>${xmlText(value)}</string>`).join("");
  const bytes = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${label}</string>`,
    `<key>ProgramArguments</key><array>${args}</array>`,
    '<key>RunAtLoad</key><true/>',
    '</dict></plist>',
    '',
  ].join("\n");
  if (Buffer.byteLength(bytes) > limit) throw refusal();
  return { root, label, plist: join(root, `${label}.plist`), argv: [...argv], ...(daemonHome === undefined ? {} : { daemonHome }), bytes };
}

function uid(): number {
  const id = process.getuid?.();
  if (process.platform !== "darwin" || id === undefined || id === 0) throw refusal();
  return id;
}

function verifyRoot(plan: DarwinSeatHostPlan): void {
  checkDir(plan.root);
  if (realpathSync.native(plan.root) !== plan.root ||
      /(?:^|\/)Library\/LaunchAgents(?:\/|$)/i.test(plan.root)) throw refusal();
}

function checkSource(plan: DarwinSeatHostPlan): void {
  verifyRoot(plan);
  const fd = openSync(plan.plist, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.size > limit) throw refusal();
    const expected = Buffer.from(plan.bytes);
    if (stat.size !== expected.length) throw refusal();
    const bytes = Buffer.alloc(expected.length + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = readSync(fd, bytes, count, bytes.length - count, null);
      if (read === 0) break;
      count += read;
    }
    if (!bytes.subarray(0, count).equals(expected)) throw refusal();
  } finally { closeSync(fd); }
}

function publish(plan: DarwinSeatHostPlan): void {
  verifyRoot(plan);
  const temporary = join(plan.root, `.plist-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    try { writeFileSync(fd, plan.bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    linkSync(temporary, plan.plist);
  } finally { unlinkSync(temporary); }
  checkSource(plan);
}

function observeLife(pid: number): DarwinSeatHostLifetime {
  const start = processStartTime(pid);
  if (!start) throw refusal();
  return { pid, start, boot: darwinBootSession() };
}

/** A Manager can request bootstrap only while its exact background daemon is still its parent. */
function checkParent(plan: DarwinSeatHostPlan): DarwinSeatHostLifetime {
  uid();
  const home = plan.daemonHome;
  const label = launchAgentLabel(home);
  const paths = home === undefined ? daemonPaths() : daemonPathsFor(home);
  const recorded = planUninstall(paths, home);
  const detected = darwinLaunchdJob(label);
  if (recorded.mechanism !== "launchd-agent" || recorded.unit !== label || detected.state !== "loaded" ||
      detected.job.label !== label || detected.job.pid !== process.ppid || detected.job.pid <= 1) throw refusal();
  return observeLife(detected.job.pid);
}

/** Register only a new job. Existing or uncertain jobs are left alone for authenticated adoption. */
export function bootstrapDarwinSeatHost(plan: DarwinSeatHostPlan): void {
  const parent = checkParent(plan);
  const domain = `gui/${uid()}`;
  if (nativeRun(launchctl, ["print", `${domain}/${plan.label}`], undefined, 1500).status !== 113) throw refusal();
  for (const path of plan.argv.slice(0, 2)) {
    if (!lstatSync(path).isFile() || realpathSync.native(path) !== path) throw refusal();
  }
  publish(plan);
  // An ambiguous bootstrap may have executed. Retain the source and never retry it here.
  const current = checkParent(plan);
  if (current.start !== parent.start || current.boot !== parent.boot || current.pid !== parent.pid ||
      nativeRun(launchctl, ["bootstrap", domain, plan.plist], undefined, 5000).status !== 0) throw refusal();
}

/** Inspect a freshly started sibling. This is a candidate identity, not socket authentication. */
export function readDarwinSeatHostLifetime(plan: DarwinSeatHostPlan): DarwinSeatHostLifetime {
  checkSource(plan);
  if (nativeRun(launchctl, ["print", `gui/${uid()}/${plan.label}`], undefined, 1500).status !== 0) throw refusal();
  const detected = darwinLaunchdJob(plan.label);
  if (detected.state !== "loaded" || detected.job.label !== plan.label || detected.job.program !== plan.argv[0] ||
      JSON.stringify(detected.job.programArguments) !== JSON.stringify(plan.argv) ||
      detected.job.pid === undefined || detected.job.pid <= 1) throw refusal();
  return observeLife(detected.job.pid);
}

/** Check the recorded launch and the connected host before the shared protocol sends a byte. */
export function verifyDarwinSeatHostPeer(plan: DarwinSeatHostPlan, expected: DarwinSeatHostLifetime, socket: Socket): void {
  const peer = localPeerCredentials(socket);
  if (peer.uid !== uid() || peer.pid !== expected.pid) throw refusal();
  const live = readDarwinSeatHostLifetime(plan);
  if (live.pid !== peer.pid || live.start !== expected.start || live.boot !== expected.boot) throw refusal();
}
