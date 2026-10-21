/**
 * The protected-path rule in `protected-records.ts`. Group write is accepted only when the account
 * database proves the group is the caller's user private group, as Debian's OpenSSH does for
 * StrictModes, the account list comes only from local name services, and the entry has no
 * extended ACL. World write, a foreign owner and a symlink always refuse, a root-owned sticky
 * ancestor is accepted, and a credential file keeps its owner-only rule. The account database and
 * the ACL read are injected, so no case reads this machine's accounts or ACLs. Only `win32`
 * selects the Windows record model; the platform is passed in, so that runs here. Broker-free.
 *
 * Run: pnpm smoke:protected-paths
 */
import { strict as nodeAssert } from "node:assert";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailure } from "../src/output.js";
import {
  assertProtectedEntry, localRecordAccess, privateGroupGap, protectedCredentialReference, protectedFileAccessAvailable,
  protectedLocalDirectory, protectedPathPolicy, type AccountDatabase, type ProtectedPathPolicy,
} from "../src/protected-records.js";

if (process.platform === "win32") skipSuite("protected paths are POSIX-only");
const counted = countedAssert(nodeAssert);
const assert: typeof nodeAssert = counted.assert;
const cells = counted.cells;

const ME = 1000;
const ROOT_LINE = "root:x:0:0:root:/root:/bin/bash";
const ME_LINE = "dev:x:1000:1000:Dev:/home/dev:/bin/bash";

/** An Ubuntu-style /etc/nsswitch.conf, with comments and other databases. */
const UBUNTU_NSSWITCH = `# /etc/nsswitch.conf
passwd:         files systemd
group:          files systemd
shadow:         files systemd
gshadow:        files systemd

hosts:          files mdns4_minimal [NOTFOUND=return] dns
netgroup:       nis
`;

/** A stock Ubuntu account database: `dev` owns the private group 1000, and `sudo` is shared. */
function accounts(over: Partial<AccountDatabase> = {}): AccountDatabase {
  return {
    nameServices: () => UBUNTU_NSSWITCH,
    user: (uid) => (uid === ME ? `${ME_LINE}\n` : ""),
    group: (gid) => (gid === 1000 ? "dev:x:1000:\n" : gid === 27 ? "sudo:x:27:dev\n" : ""),
    users: () => `${ROOT_LINE}\n${ME_LINE}\n`,
    ...over,
  };
}
const failing = (reason: string) => (): string => { throw new Error(reason); };
const noAcl = () => "";

// 1. The private-group proof against an injected account database.
assert.equal(privateGroupGap(accounts(), ME, 1000), undefined, "UPG: the caller's private group is accepted");
assert.equal(privateGroupGap(accounts({ group: () => "dev:x:1000:dev\n" }), ME, 1000), undefined, "UPG: listing the caller alone is accepted");
assert.equal(privateGroupGap(accounts({ group: () => "dev:x:1000:dev,eve\n" }), ME, 1000), "its group has other members", "another listed member refuses");
assert.equal(
  privateGroupGap(accounts({ users: () => `${ROOT_LINE}\n${ME_LINE}\neve:x:1001:1000::/home/eve:/bin/sh\n` }), ME, 1000),
  "another account has its group as its primary group", "another account with the same primary gid refuses");
assert.equal(privateGroupGap(accounts(), ME, 27), "its group is not your primary group", "a shared supplementary group refuses");
for (const [name, over, reason] of [
  ["a failed group lookup", { group: failing("getent group 1000 timed out") }, /unavailable: getent group 1000 timed out$/],
  ["a missing getent", { user: failing("getent is not installed") }, /unavailable: getent is not installed$/],
  ["an unparsable enumeration", { users: () => "not an account line\n" }, /unavailable: getent passwd output cannot be parsed$/],
  ["an unparsable group", { group: () => "dev:x:1000\n" }, /unavailable: getent group output cannot be parsed$/],
  ["a group row for another gid", { group: () => "dev:x:1001:\n" }, /unavailable: getent group output cannot be parsed$/],
  ["an enumeration without the caller", { users: () => `${ROOT_LINE}\n` }, /unavailable: .*may be partial$/],
] as const) assert.match(privateGroupGap(accounts(over), ME, 1000) ?? "accepted", reason, `${name} refuses as an unavailable proof`);

// 1b. A clean `getent passwd` exit is a complete account list only when passwd and group come from
//     local sources. Here a directory source lists the caller and hides `eve`, whose primary group
//     is 1000; nsswitch.conf alone must refuse it, before any getent read.
const hiddenPrimary = (nsswitch: () => string) => {
  let reads = 0;
  const base = accounts({ nameServices: nsswitch });
  const gap = privateGroupGap({ ...base, user: (uid) => { reads++; return base.user(uid); }, group: (gid) => { reads++; return base.group(gid); }, users: () => { reads++; return base.users(); } }, ME, 1000);
  return { gap, reads };
};
assert.equal(privateGroupGap(accounts({ nameServices: () => "passwd: files [SUCCESS=merge] systemd\ngroup: files [NOTFOUND=return] systemd\n" }), ME, 1000), undefined,
  "files and systemd are accepted, with bracketed action items ignored");
for (const [name, nsswitch, reason] of [
  ["sss for passwd and group", () => "passwd: files sss\ngroup: files sss\n", /unavailable: \/etc\/nsswitch\.conf names sss for passwd, which may list only part of its accounts$/],
  ["compat", () => "passwd: compat\ngroup: compat\n", /unavailable: \/etc\/nsswitch\.conf names compat for passwd, /],
  ["ldap for group only", () => "passwd: files systemd\ngroup: files ldap\n", /unavailable: \/etc\/nsswitch\.conf names ldap for group, /],
  ["a missing nsswitch.conf", failing("/etc/nsswitch.conf is missing"), /unavailable: \/etc\/nsswitch\.conf is missing$/],
  ["an unreadable nsswitch.conf", failing("/etc/nsswitch.conf cannot be read"), /unavailable: \/etc\/nsswitch\.conf cannot be read$/],
  ["no group line", () => "passwd: files\n", /unavailable: \/etc\/nsswitch\.conf names no source for group$/],
  ["an empty passwd line", () => "passwd:\ngroup: files\n", /unavailable: \/etc\/nsswitch\.conf names no source for passwd$/],
  ["a line without a colon", () => "passwd files\ngroup: files\n", /unavailable: \/etc\/nsswitch\.conf has a line that cannot be parsed$/],
  ["a second passwd line", () => "passwd: files\ngroup: files\npasswd: ldap\n", /unavailable: \/etc\/nsswitch\.conf has a line that cannot be parsed$/],
  ["an unclosed action item", () => "passwd: files [NOTFOUND=return\ngroup: files\n", /unavailable: \/etc\/nsswitch\.conf has a line that cannot be parsed$/],
] as const) {
  const { gap, reads } = hiddenPrimary(nsswitch);
  assert.match(gap ?? "accepted", reason, `${name} refuses as an unavailable proof`);
  assert.equal(reads, 0, `${name} refuses before any getent read`);
}

// 2. A proven group is remembered. Any other verdict is read again, so a transient failure does not stick.
{
  const calls = { user: 0, group: 0, users: 0 };
  const base = accounts();
  let enumerationDown = true;
  const policy = protectedPathPolicy({
    nameServices: base.nameServices,
    user: (uid) => { calls.user++; return base.user(uid); },
    group: (gid) => { calls.group++; return base.group(gid); },
    users: () => { calls.users++; if (enumerationDown) throw new Error("getent passwd timed out"); return base.users(); },
  }, noAcl, ME);
  assert.match(policy.privateGroupGap(1000) ?? "accepted", /unavailable: getent passwd timed out$/, "a transient lookup failure refuses");
  enumerationDown = false;
  assert.equal(policy.privateGroupGap(1000), undefined, "the next check reads again and proves the group");
  assert.equal(policy.privateGroupGap(1000), undefined, "the proven group is remembered");
  assert.deepEqual(calls, { user: 2, group: 2, users: 2 }, "an unavailable verdict is not cached, and a proven one is");
}

// 3. The entry rule over stat shapes no test could create without root.
const probes: string[] = [];
const policy = protectedPathPolicy(accounts(), (path) => { probes.push(path); return ""; }, ME);
const unproven: ProtectedPathPolicy = { uid: ME, privateGroupGap: () => "the private-group proof is unavailable: getent is not installed", extendedAcl: noAcl };
const DIR = 0o040000, FILE = 0o100000;
const stat = (mode: number, uid = ME, gid = 1000, link = false) => ({
  uid, gid, mode, isDirectory: () => !link && (mode & 0o170000) === DIR, isSymbolicLink: () => link,
});

/** A string `reason` is the whole message; a pattern matches part of it. */
function refused(fn: () => void, reason: RegExp | string, remedy: string, name: string): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof CommandFailure, `${name}: expected a refusal, got ${thrown === undefined ? "acceptance" : String(thrown)}`);
  const failure = thrown as CommandFailure;
  assert.equal(failure.code, "PERMISSION_DENIED", `${name}: code`);
  if (typeof reason === "string") assert.equal(failure.message, reason, `${name}: message`);
  else assert.match(failure.message, reason, `${name}: reason`);
  assert.equal(failure.remedy, remedy, `${name}: remedy`);
}
// The remedy quotes a path the shell would split, as a real temporary directory might need.
const shellPath = (path: string) => /^[A-Za-z0-9_./+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
const accepts = (fn: () => void, name: string) => assert.doesNotThrow(fn, `${name} is accepted`);

accepts(() => assertProtectedEntry("the path", "/home/dev", stat(DIR | 0o755), { ancestor: true, policy }), "an owner-only directory");
accepts(() => assertProtectedEntry("the path", "/home/dev/Projects", stat(DIR | 0o775), { ancestor: true, policy }), "a UPG group-writable ancestor");
accepts(() => assertProtectedEntry("the declared adapter path", "/home/dev/bin/nats-server", stat(FILE | 0o775), { policy }), "a UPG group-writable adapter file");
accepts(() => assertProtectedEntry("the path", "/tmp", stat(DIR | 0o1777, 0, 0), { ancestor: true, policy }), "a root-owned sticky ancestor");
refused(() => assertProtectedEntry("the path", "/tmp", stat(DIR | 0o1777, 0, 0), { policy }),
  /: \/tmp is writable by every local account$/, "chmod o-w /tmp", "a root-owned sticky adapter entry keeps the entry rule");
refused(() => assertProtectedEntry("the project root", "/home/dev/shared", stat(DIR | 0o777), { ancestor: true, policy }),
  /^the project root is not protected against other local writers: \/home\/dev\/shared is writable by every local account$/,
  "chmod o-w /home/dev/shared", "world write, even with a private group");
refused(() => assertProtectedEntry("the path", "/home/eve", stat(DIR | 0o755, 1001, 1001), { ancestor: true, policy }),
  /: \/home\/eve is owned by another account$/, "use a physical path owned by you or root, without symlinks", "a foreign owner");
refused(() => assertProtectedEntry("the path", "/home/dev/link", stat(0o120777, ME, 1000, true), { ancestor: true, policy }),
  /: \/home\/dev\/link is a symbolic link$/, "use a physical path owned by you or root, without symlinks", "a symlink");
refused(() => assertProtectedEntry("the path", "/srv/team", stat(DIR | 0o775, ME, 27), { ancestor: true, policy }),
  /: \/srv\/team is group-writable and its group is not your primary group$/, "chmod g-w /srv/team", "a shared group");
refused(() => assertProtectedEntry("the path", "/usr/local", stat(DIR | 0o2775, 0, 50), { ancestor: true, policy }),
  /: \/usr\/local is group-writable and it is not owned by you$/, "chmod g-w /usr/local", "a root-owned group-writable directory");
refused(() => assertProtectedEntry("the path", "/home/dev/my work", stat(DIR | 0o775), { ancestor: true, policy: unproven }),
  /: \/home\/dev\/my work is group-writable and the private-group proof is unavailable: getent is not installed$/,
  "chmod g-w '/home/dev/my work'", "an unavailable proof");
assert.deepEqual(probes, ["/home/dev/Projects", "/home/dev/bin/nats-server"], "the ACL is read only where the private-group proof accepts group write");

// 4. An extended ACL can grant write that the group bits only mask, so a proven group is not enough.
const aclPolicy = (acl: (path: string) => string) => protectedPathPolicy(accounts(), acl, ME);
refused(() => assertProtectedEntry("the path", "/home/dev/acl", stat(DIR | 0o775), { ancestor: true, policy: aclPolicy(() => "# file: /home/dev/acl\nuser::rwx\nuser:eve:rwx\ngroup::rwx\nmask::rwx\nother::r-x\n\n") }),
  /: \/home\/dev\/acl is group-writable and has an extended ACL$/, "chmod g-w /home/dev/acl", "a named-user ACL entry");
refused(() => assertProtectedEntry("the path", "/home/dev/acl", stat(DIR | 0o775), { ancestor: true, policy: aclPolicy(() => "# file: /home/dev/acl\nuser::rwx\ngroup::rwx\nother::r-x\ndefault:user:eve:rwx\n\n") }),
  /: \/home\/dev\/acl is group-writable and has an extended ACL$/, "chmod g-w /home/dev/acl", "a default ACL entry");
refused(() => assertProtectedEntry("the path", "/home/dev/Projects", stat(DIR | 0o775), { ancestor: true, policy: aclPolicy(failing("getfacl is not installed")) }),
  /: \/home\/dev\/Projects is group-writable and the private-group proof is unavailable: getfacl is not installed$/,
  "chmod g-w /home/dev/Projects, or install acl", "a missing getfacl");
refused(() => assertProtectedEntry("the path", "/home/dev/Projects", stat(FILE | 0o664), { policy: aclPolicy(failing("getfacl failed or exceeded its output limit")) }),
  /: \/home\/dev\/Projects is group-writable and the private-group proof is unavailable: getfacl failed or exceeded its output limit$/,
  "chmod g-w /home/dev/Projects, or install acl", "a failed getfacl");

// 5. The same rule on real paths. Each refusal is the leaf, so this machine's ancestors are never read.
//    These paths belong to the real caller, and no group on them is proven.
const local: ProtectedPathPolicy = { uid: process.getuid!(), privateGroupGap: unproven.privateGroupGap, extendedAcl: noAcl };
const dir = mkdtempSync(join(tmpdir(), "cotal-protected-paths-"));
try {
  const open = join(dir, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  refused(() => protectedLocalDirectory(open, "the project root", local),
    `the project root is not protected against other local writers: ${open} is writable by every local account`,
    `chmod o-w ${shellPath(open)}`, "a real world-writable directory");
  const grouped = join(dir, "grouped");
  mkdirSync(grouped);
  chmodSync(grouped, 0o770);
  refused(() => protectedLocalDirectory(grouped, undefined, local),
    `the path is not protected against other local writers: ${grouped} is group-writable and the private-group proof is unavailable: getent is not installed`,
    `chmod g-w ${shellPath(grouped)}`, "a real group-writable directory without a proof");
  const link = join(dir, "link");
  symlinkSync(grouped, link);
  refused(() => protectedLocalDirectory(link, "the path", local), /: .*\/link is a symbolic link$/,
    "use a physical path owned by you or root, without symlinks", "a real symlink");

  // A credential keeps its owner-only rule: group write refuses before any group is considered.
  const creds = join(dir, "creds");
  writeFileSync(creds, "not a credential", { mode: 0o600 });
  chmodSync(creds, 0o660);
  let thrown: unknown;
  try { protectedCredentialReference(creds); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof CommandFailure && thrown.code === "PERMISSION_DENIED", "a group-writable credential file refuses");
  assert.match((thrown as Error).message, /must be an owned private regular file/, "a group-writable credential file names the file rule");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 6. One place picks the record model from the platform. Only win32 takes the Windows access-list
//    model; every other platform keeps the owner, mode and link checks, and this host has them.
assert.equal(localRecordAccess("win32"), "windows-acl", "win32 selects the Windows access-list model");
for (const platform of ["linux", "darwin", "freebsd"] as const)
  assert.equal(localRecordAccess(platform), "posix", `${platform} keeps the POSIX owner, mode and link checks`);
assert.equal(localRecordAccess(), "posix", "this host selects the POSIX model");
assert.equal(protectedFileAccessAvailable(), true, "this host has protected local-record access");

console.log("protected-paths smoke: OK - a proven user private group without an extended ACL is accepted, other members, other primary accounts, non-local name services, extended ACLs and unavailable proofs refuse, only a proven group is cached, world write, foreign owners and symlinks always refuse, a root sticky ancestor is accepted, a credential keeps its owner-only rule, and only win32 selects the Windows record model");
emitSentinel({ passed: cells(), failed: 0 });
