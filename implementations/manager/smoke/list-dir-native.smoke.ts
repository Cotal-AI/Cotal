import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listDirectory } from "../src/list-dir.js";

const root = await mkdtemp(join(tmpdir(), "list-dir-native-"));
try {
  const home = await listDirectory(await realpath(homedir()), false, 200);
  assert.equal(home.path, await realpath(homedir()));
  assert.ok(home.directories.length <= 200);
  for (const path of home.roots) assert.ok((await stat(path)).isDirectory(), `reported root exists: ${path}`);
  if (process.platform === "win32") assert.ok(home.roots.some((path) => /^[A-Z]:\\$/.test(path)));
  else assert.ok(home.roots.includes("/"));
  if (process.platform === "darwin") assert.ok(home.roots.includes("/Volumes"));
  await mkdir(join(root, "visible"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "file.txt"), "not listed");
  // A junction avoids Windows symlink privileges. macOS/Linux exercise a directory symlink.
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(join(root, "visible"), join(root, "linked"), linkType);
  const canonical = await realpath(root);
  const plain = await listDirectory(canonical, false, 200);
  assert.deepEqual(plain.directories, [{ name: "linked", symlink: true }, { name: "visible", symlink: false }]);
  const hidden = await listDirectory(canonical, true, 200);
  assert.deepEqual(hidden.directories.map((entry) => entry.name), [".hidden", "linked", "visible"]);
  const bounded = await listDirectory(canonical, true, 1);
  assert.equal(bounded.directories.length, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(await realpath(join(root, "linked")), await realpath(join(root, "visible")));
  console.log(`PASS native list-dir platform=${process.platform} link=${linkType} home=true roots=${JSON.stringify(home.roots)} hidden=true bounded=true`);
} finally {
  await rm(root, { recursive: true, force: true });
}
