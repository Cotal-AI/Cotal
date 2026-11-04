/**
 * The protected-path rule in `protected-records.ts`. Group write is accepted only when the account
 * database proves the group is the caller's user private group, as Debian's OpenSSH does for
 * StrictModes, the account list comes only from local name services, and the entry has no
 * extended ACL. World write, a foreign owner and a symlink always refuse, a root-owned sticky
 * ancestor is accepted, and a credential file keeps its owner-only rule. A declared adapter path in
 * Cotal's own install, as the launcher runs it, names `cotal update` as the fix. The account database and
 * the ACL read are injected, so no case reads this machine's accounts or ACLs. A record this account
 * may not open names the folder that withholds it, as does a store folder it may not enter or write,
 * each chmod step quoting a path a shell would split,
 * and a link keeps the no-follow refusal. Only `win32` selects the Windows record model; the platform
 * is passed in, so that runs here. Broker-free.
 *
 * Run: pnpm smoke:protected-paths
 */
import { strict as nodeAssert } from "node:assert";
import { countedAssert, emitSentinel, skipSuite } from "@cotal-ai/smoke-kit";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandFailure } from "../src/output.js";
import {
  assertProtectedEntry, localRecordAccess, privateGroupGap, protectedCredentialReference, protectedFileAccessAvailable,
  protectedLocalDirectory, protectedLocalEntries, protectedLocalEntry, protectedPathPolicy, ProtectedRecordStore, readLocalRecordSource, type AccountDatabase, type ProtectedPathPolicy,
} from "../src/protected-records.js";
import { validateServiceAdapterPaths } from "../src/service-adapter.js";

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
  /: \/tmp is writable by every local account$/, "chmod go-w /tmp", "a root-owned sticky adapter entry keeps the entry rule");
refused(() => assertProtectedEntry("the project root", "/home/dev/shared", stat(DIR | 0o777), { ancestor: true, policy }),
  /^the project root is not protected against other local writers: \/home\/dev\/shared is writable by every local account$/,
  "chmod go-w /home/dev/shared", "world write, even with a private group, removes group write in the same step");
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

// 5. The same rule on real paths. The walk reads the whole chain, so the temporary directory and its
//    ancestors must themselves be protected. These paths belong to the real caller, and no group on
//    them is proven.
const local: ProtectedPathPolicy = { uid: process.getuid!(), privateGroupGap: unproven.privateGroupGap, extendedAcl: noAcl };
const dir = mkdtempSync(join(tmpdir(), "cotal-protected-paths-"));
try {
  const open = join(dir, "open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  refused(() => protectedLocalDirectory(open, "the project root", local),
    `the project root is not protected against other local writers: ${open} is writable by every local account`,
    `chmod go-w ${shellPath(open)}`, "a real directory its group and every account can write, in one step");
  const grouped = join(dir, "grouped");
  mkdirSync(grouped);
  chmodSync(grouped, 0o770);
  refused(() => protectedLocalDirectory(grouped, undefined, local),
    `the path is not protected against other local writers: ${grouped} is group-writable and the private-group proof is unavailable: getent is not installed`,
    `chmod g-w ${shellPath(grouped)}`, "a real group-writable directory without a proof");
  // The whole chain is read, so one refusal names a folder and its parent together, with one command.
  const inner = join(grouped, "inner");
  mkdirSync(inner);
  chmodSync(inner, 0o770);
  refused(() => protectedLocalDirectory(inner, "the project root", local),
    `the project root is not protected against other local writers: ${inner} and ${grouped} are group-writable and the private-group proof is unavailable: getent is not installed`,
    `chmod g-w ${shellPath(inner)} ${shellPath(grouped)}`, "a real group-writable folder under a group-writable parent");
  // An entry and its folders are read together, as `npm i -g` under umask 0002 lays out a binary,
  // so one refusal names all of them with one command.
  const binary = join(inner, "nats-server");
  writeFileSync(binary, "", { mode: 0o700 });
  chmodSync(binary, 0o775);
  refused(() => protectedLocalEntry(binary, "the declared adapter path binary", local),
    `the declared adapter path binary is not protected against other local writers: ${binary}, ${inner} and ${grouped} are group-writable and the private-group proof is unavailable: getent is not installed`,
    `chmod g-w ${shellPath(binary)} ${shellPath(inner)} ${shellPath(grouped)}`, "a real group-writable file in group-writable folders");
  // A directory and the named entries in it are read with its folders, as a backup artifact is, so
  // one refusal names the directory, each unsafe entry and each unsafe folder above it.
  const artifact = join(inner, "artifact");
  mkdirSync(artifact);
  chmodSync(artifact, 0o770);
  for (const name of ["manifest.json", "safe.snap"]) writeFileSync(join(artifact, name), "", { mode: 0o600 });
  chmodSync(join(artifact, "manifest.json"), 0o660);
  refused(() => protectedLocalEntries(artifact, ["manifest.json", "safe.snap"], "the backup artifact", local),
    `the backup artifact is not protected against other local writers: ${artifact}, ${join(artifact, "manifest.json")}, ${inner} and ${grouped} are group-writable and the private-group proof is unavailable: getent is not installed`,
    `chmod g-w ${shellPath(artifact)} ${shellPath(join(artifact, "manifest.json"))} ${shellPath(inner)} ${shellPath(grouped)}`, "a group-writable directory and entry in group-writable folders");
  const mixed = join(open, "inner");
  mkdirSync(mixed);
  chmodSync(mixed, 0o770);
  refused(() => protectedLocalDirectory(mixed, "the project root", local),
    `the project root is not protected against other local writers: ${mixed} is group-writable and the private-group proof is unavailable: getent is not installed; ${open} is writable by every local account`,
    `chmod go-w ${shellPath(mixed)} ${shellPath(open)}`, "a group-writable folder under a world-writable parent, in one chmod");
  const link = join(dir, "link");
  symlinkSync(grouped, link);
  refused(() => protectedLocalDirectory(link, "the path", local), /: .*\/link is a symbolic link$/,
    `use the physical path ${shellPath(realpathSync.native(grouped))}`, "a real symlink names the path it resolves to");
  // A link above the checked folder: the remedy names that folder's own physical path.
  const clean = join(dir, "clean");
  mkdirSync(join(clean, "sub"), { recursive: true, mode: 0o700 });
  chmodSync(clean, 0o700);
  const above = join(dir, "above");
  symlinkSync(clean, above);
  refused(() => protectedLocalDirectory(join(above, "sub"), "the project root", local), /: .*\/above is a symbolic link$/,
    `use the physical path ${shellPath(realpathSync.native(join(clean, "sub")))}`, "a link above the folder names the folder's physical path");

  // A credential keeps its owner-only rule: group write refuses before any group is considered.
  const creds = join(dir, "creds");
  writeFileSync(creds, "not a credential", { mode: 0o600 });
  chmodSync(creds, 0o660);
  let thrown: unknown;
  try { protectedCredentialReference(creds); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof CommandFailure && thrown.code === "PERMISSION_DENIED", "a group-writable credential file refuses");
  assert.match((thrown as Error).message, /must be an owned private regular file/, "a group-writable credential file names the file rule");
  assert.ok((thrown as Error).message.includes(`the referenced credential ${creds} `) && ((thrown as CommandFailure).target as { path?: unknown } | undefined)?.path === creds, "it names the file, in the text and the target");
  assert.equal((thrown as CommandFailure).remedy, `chmod 600 ${shellPath(creds)}`, "its Next is the chmod that makes the file private");
  // A file that is not there is absent, not an outage, and is named too.
  const gone = join(dir, "gone.creds");
  let missing: unknown;
  try { protectedCredentialReference(gone); } catch (error) { missing = error; }
  assert.ok(missing instanceof CommandFailure && missing.code === "TARGET_NOT_FOUND" && missing.message === `the referenced credential ${gone} does not exist`
    && (missing.target as { path?: unknown } | undefined)?.path === gone, `a missing credential file refuses TARGET_NOT_FOUND, naming it\n${String(missing)}`);
  // The bounded reader names the file it refused, too: a link it does not follow, and a saved record
  // that is not private.
  const credsLink = join(dir, "creds-link");
  symlinkSync(creds, credsLink);
  for (const [path, mode, text] of [[credsLink, 0o600, `the local record source ${credsLink} could not be opened without following links`], [creds, 0o640, `the saved local record ${creds} is not owned and private`]] as const) {
    chmodSync(creds, mode);
    let read: unknown;
    try { readLocalRecordSource(path, 1024, true); } catch (error) { read = error; }
    assert.ok(read instanceof CommandFailure && read.code === "PERMISSION_DENIED" && read.message === text && (read.target as { path?: unknown } | undefined)?.path === path, `${path} (mode ${mode.toString(8)}) is refused naming it\n${String(read)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// 5b. A handler in Cotal's own install, as the launcher runs it, refuses with `cotal update` as the
//     fix, because the update removes that write. Any other path keeps its chmod. World write is used,
//     since group write is accepted on a host that proves the user's private group.
{
  const base = mkdtempSync(join(tmpdir(), "cotal-launcher-install-"));
  const install = join(base, "cotal");
  const runtime = join(install, "runtime", "node-v0-linux-x64");
  const prior = { launcher: process.env.COTAL_LAUNCHER, prefix: process.env.npm_config_prefix };
  try {
    mkdirSync(join(runtime, "bin"), { recursive: true });
    const handler = join(runtime, "bin", "node");
    writeFileSync(handler, "", { mode: 0o755 });
    for (const path of [install, join(install, "runtime"), runtime]) chmodSync(path, 0o757);
    const declaration = { abiVersion: 1, paths: { handler: "file" } } as unknown as Parameters<typeof validateServiceAdapterPaths>[0];
    const refusal = (): CommandFailure => {
      try { validateServiceAdapterPaths(declaration, { handler }); } catch (error) { if (error instanceof CommandFailure) return error; throw error; }
      throw new Error("the handler was accepted");
    };
    delete process.env.COTAL_LAUNCHER;
    assert.equal(refusal().remedy, `chmod o-w ${runtime} ${join(install, "runtime")} ${install}`, "outside the launcher the handler refusal keeps its chmod");
    process.env.COTAL_LAUNCHER = "1";
    process.env.npm_config_prefix = install;
    const own = refusal();
    assert.ok(own.message.endsWith(`; those folders belong to Cotal's own install at ${install}`), `under the launcher the refusal says the folders are Cotal's own install: ${own.message}`);
    assert.match(own.remedy ?? "", /^cotal update, /, "and its Next is cotal update");
    chmodSync(base, 0o757);
    assert.match(refusal().remedy ?? "", /^chmod o-w /, "a gap outside the install keeps the chmod");
  } finally {
    if (prior.launcher === undefined) delete process.env.COTAL_LAUNCHER; else process.env.COTAL_LAUNCHER = prior.launcher;
    if (prior.prefix === undefined) delete process.env.npm_config_prefix; else process.env.npm_config_prefix = prior.prefix;
    chmodSync(base, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
}

// 6. A record this account may not open is refused with the folder that withholds it, which is often
//    a folder above the file. A link stays the no-follow refusal; an absent file is no record.
if (process.getuid?.() !== 0) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-protected-read-")));
  try {
    const shut = join(base, "shut");
    mkdirSync(join(shut, ".cotal"), { recursive: true, mode: 0o700 });
    const record = join(shut, ".cotal", "record.json");
    writeFileSync(record, "{}", { mode: 0o600 });
    chmodSync(shut, 0o000);
    let thrown: unknown;
    try { readLocalRecordSource(record); } catch (error) { thrown = error; }
    chmodSync(shut, 0o700);
    assert.ok(thrown instanceof CommandFailure && thrown.code === "PERMISSION_DENIED", "a record under a folder this account cannot search refuses");
    assert.equal((thrown as CommandFailure).message, `${shut} cannot be read by this account (EACCES), so ${record} was not read`, "the refusal names the folder, not the file or a link");
    assert.equal((thrown as CommandFailure).remedy, `make it readable by you, for example with chmod u+rx ${shut}`, "its remedy is the chmod on that folder");
    chmodSync(record, 0o000);
    thrown = undefined;
    try { readLocalRecordSource(record); } catch (error) { thrown = error; }
    chmodSync(record, 0o600);
    assert.equal((thrown as CommandFailure | undefined)?.message, `${record} cannot be read by this account (EACCES)`, "an unreadable file in a readable folder is named itself");
    const link = join(base, "link.json");
    symlinkSync(record, link);
    thrown = undefined;
    try { readLocalRecordSource(link); } catch (error) { thrown = error; }
    assert.equal((thrown as CommandFailure | undefined)?.message, `the local record source ${link} could not be opened without following links`, "a link keeps the no-follow refusal and names the link");
    assert.equal(readLocalRecordSource(join(base, "absent.json")), undefined, "an absent file is no record");
  } finally {
    try { chmodSync(join(base, "shut"), 0o700); } catch { /* already restored */ }
    rmSync(base, { recursive: true, force: true });
  }
}

// 6a. Under a Cotal home whose path has spaces, both chmod steps quote the path, so a copied step
//     names that one path. They used to print it bare, and a shell split it into several.
if (process.getuid?.() !== 0) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal protected read ")));
  try {
    const shut = join(base, "my cotal home");
    mkdirSync(shut, { mode: 0o700 });
    const record = join(shut, "record.json");
    writeFileSync(record, "{}", { mode: 0o600 });
    const refused = (): CommandFailure | undefined => { try { readLocalRecordSource(record); } catch (error) { return error as CommandFailure; } return undefined; };
    chmodSync(record, 0o000);
    const file = refused();
    chmodSync(record, 0o600);
    assert.equal(file?.remedy, `make it readable by you, for example with chmod u+r '${record}'`, "an unreadable file's chmod quotes its path");
    chmodSync(shut, 0o000);
    const folder = refused();
    chmodSync(shut, 0o700);
    assert.equal(folder?.remedy, `make it readable by you, for example with chmod u+rx '${shut}'`, "an unsearchable folder's chmod quotes its path");
  } finally {
    try { chmodSync(join(base, "my cotal home"), 0o700); } catch { /* already restored */ }
    rmSync(base, { recursive: true, force: true });
  }
}

// 6b. A store folder this account may not enter is refused with that folder and the chmod that gives
//     it back, whether it is the family folder itself or the space folder above it.
if (process.getuid?.() !== 0) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-protected-store-")));
  const prior = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(base, ".cotal");
  const instances = new ProtectedRecordStore("services", "s1", (value) => value, "instances");
  const definitions = new ProtectedRecordStore("services", "s1", (value) => value, "definitions");
  const shutDir = instances.directory(true)!;
  const space = join(shutDir, "..");
  definitions.directory(true);
  const refusal = (read: () => unknown): CommandFailure => {
    try { read(); } catch (error) { if (error instanceof CommandFailure) return error; throw error; }
    throw new Error("the read did not refuse");
  };
  try {
    chmodSync(shutDir, 0o000);
    const shut = refusal(() => instances.list());
    chmodSync(shutDir, 0o700);
    assert.equal(shut.code, "PERMISSION_DENIED", "a family folder this account cannot read refuses PERMISSION_DENIED");
    assert.equal(shut.message, `${shutDir} cannot be read by this account (EACCES), so the saved local records under it were not read`, "the refusal names that folder");
    assert.equal(shut.remedy, `make it readable by you, for example with chmod u+rwx ${shutDir}`, "its remedy is the chmod on that folder");
    chmodSync(space, 0o000);
    const reads = [refusal(() => instances.list()), refusal(() => definitions.list()), refusal(() => definitions.read("echo"))];
    chmodSync(space, 0o700);
    for (const failure of reads) {
      assert.equal(failure.message, `${space} cannot be read by this account (EACCES), so the saved local records under it were not read`, "a shut space folder is named for every family under it");
      assert.equal(failure.remedy, `make it readable by you, for example with chmod u+rwx ${space}`, "with the chmod on the space folder");
    }
    assert.deepEqual(instances.list(), [], "once readable again the store reads as it is");
  } finally {
    try { chmodSync(space, 0o700); chmodSync(shutDir, 0o700); } catch { /* already restored */ }
    if (prior === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prior;
    rmSync(base, { recursive: true, force: true });
  }
}

// 6c. A store folder this account can read but not write, as a read refusal's `chmod u+rx` leaves it,
//     still reads. A write or a pin there refuses with that folder and only the owner bits the write
//     lacks, and leaves nothing in it.
if (process.getuid?.() !== 0) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cotal-protected-write-")));
  const prior = process.env.COTAL_HOME;
  process.env.COTAL_HOME = join(base, ".cotal");
  const store = new ProtectedRecordStore("services", "s1", (value) => value, "definitions");
  const dir = store.directory(true)!;
  store.commit("tick", undefined, { n: 1 });
  const refusal = (write: () => unknown): CommandFailure => {
    try { write(); } catch (error) { if (error instanceof CommandFailure) return error; throw error; }
    throw new Error("the write did not refuse");
  };
  try {
    chmodSync(dir, 0o500);
    const tick = store.read("tick")!;
    const writes = [refusal(() => store.commit("tick2", undefined, { n: 2 })), refusal(() => store.pin(tick))];
    const left = readdirSync(dir);
    chmodSync(dir, 0o600);
    const unsearchable = refusal(() => store.commit("tick2", undefined, { n: 2 }));
    chmodSync(dir, 0o700);
    assert.deepEqual(tick.record.value, { n: 1 }, "a folder left readable only still reads");
    for (const failure of writes) {
      assert.equal(failure.code, "PERMISSION_DENIED", "a write or a pin in a folder this account cannot write refuses PERMISSION_DENIED");
      assert.equal(failure.message, `${dir} cannot be written by this account (EACCES), so no saved local record in it was locked or written`, "the refusal names that folder");
      assert.equal(failure.remedy, `make it writable by you, for example with chmod u+w ${dir}`, "its remedy adds only the write bit");
    }
    assert.deepEqual(left, [`${Buffer.from("tick").toString("hex")}.json`], "nothing was written, not even a lock");
    assert.equal(unsearchable.remedy, `make it writable by you, for example with chmod u+x ${dir}`, "a folder that has the write bit but not search names only search");
    store.commit("tick2", undefined, { n: 2 });
    assert.deepEqual(store.list().map((row) => row.name), ["tick", "tick2"], "once writable again the write lands");
  } finally {
    try { chmodSync(dir, 0o700); } catch { /* already restored */ }
    if (prior === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prior;
    rmSync(base, { recursive: true, force: true });
  }
}

// 7. One place picks the record model from the platform. Only win32 takes the Windows access-list
//    model; every other platform keeps the owner, mode and link checks, and this host has them.
assert.equal(localRecordAccess("win32"), "windows-acl", "win32 selects the Windows access-list model");
for (const platform of ["linux", "darwin", "freebsd"] as const)
  assert.equal(localRecordAccess(platform), "posix", `${platform} keeps the POSIX owner, mode and link checks`);
assert.equal(localRecordAccess(), "posix", "this host selects the POSIX model");
assert.equal(protectedFileAccessAvailable(), true, "this host has protected local-record access");

console.log("protected-paths smoke: OK - a proven user private group without an extended ACL is accepted, other members, other primary accounts, non-local name services, extended ACLs and unavailable proofs refuse, only a proven group is cached, world write, foreign owners and symlinks always refuse, a root sticky ancestor is accepted, a credential keeps its owner-only rule, and only win32 selects the Windows record model");
emitSentinel({ passed: cells(), failed: 0 });
