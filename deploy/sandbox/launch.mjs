#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";

const usage = "usage: node deploy/sandbox/launch.mjs --rootfs <directory> [--network none|host] [--input <name>=<file>] [--env <name>] -- <command> [args...]";
const fixedEnv = {
  HOME: "/home/seat", USER: "seat", LOGNAME: "seat",
  PATH: "/usr/local/bin:/usr/bin:/bin",
  TMPDIR: "/tmp", XDG_CONFIG_HOME: "/home/seat/.config",
  XDG_DATA_HOME: "/home/seat/.local/share", XDG_CACHE_HOME: "/home/seat/.cache",
  XDG_RUNTIME_DIR: "/run/user", COTAL_HOME: "/home/seat/.cotal",
};

// This composition accepts a prepared rootfs, never a host project or an inherited home.
// Inputs are copied from open regular files, not mounted parent directories or live sockets.
function launch(argv) {
  if (process.platform !== "linux") throw new Error("isolated seats require Linux and /usr/bin/bwrap");
  let rootfs;
  let network = "none";
  const inputs = new Map();
  const env = { ...fixedEnv };
  let command;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--") { command = argv.slice(i + 1); break; }
    const value = argv[++i];
    if (value === undefined) throw new Error(usage);
    if (flag === "--rootfs") {
      if (rootfs !== undefined) throw new Error("--rootfs may be supplied once");
      rootfs = realpathSync(value);
    } else if (flag === "--network") {
      if (value !== "none" && value !== "host") throw new Error("--network must be none or host");
      network = value;
    } else if (flag === "--input") {
      const split = value.indexOf("=");
      const name = value.slice(0, split);
      if (split < 1 || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || inputs.has(name))
        throw new Error("--input requires a unique simple name and a file path");
      inputs.set(name, value.slice(split + 1));
    } else if (flag === "--env") {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || Object.hasOwn(fixedEnv, value))
        throw new Error("--env requires a variable name other than a sandbox path setting");
      if (!Object.hasOwn(process.env, value)) throw new Error(`--env ${value} is not set`);
      env[value] = process.env[value];
    } else throw new Error(usage);
  }
  if (!rootfs || !command?.length || !command[0] || !statSync(rootfs).isDirectory()) throw new Error(usage);
  if (rootfs === "/") throw new Error("--rootfs must be a separately prepared filesystem, not the host root");
  // These paths are replaced by private mounts. Refuse links rather than mounting through one.
  for (const path of ["home", "run", "tmp", "work", "proc", "dev"])
    if (realpathSync(resolve(rootfs, path)) !== resolve(rootfs, path) || !statSync(resolve(rootfs, path)).isDirectory())
      throw new Error(`rootfs /${path} must be a real directory`);

  const args = [
    "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup",
    "--disable-userns", "--new-session", "--die-with-parent", "--cap-drop", "ALL",
    ...(network === "none" ? ["--unshare-net"] : []),
    "--ro-bind", rootfs, "/", "--proc", "/proc", "--dev", "/dev",
    "--tmpfs", "/home", "--dir", "/home/seat", "--tmpfs", "/tmp", "--tmpfs", "/work",
    "--tmpfs", "/run", "--perms", "0700", "--dir", "/run/user", "--dir", "/run/cotal",
    "--chdir", "/work",
  ];
  const fds = [];
  try {
    for (const [name, path] of inputs) {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      fds.push(fd);
      if (!fstatSync(fd).isFile()) throw new Error("--input must name a regular file, not a directory, link or socket");
      args.push("--perms", "0600", "--file", String(fds.length + 2), `/run/cotal/${name}`);
    }
    console.error(`cotal: isolated seat (Linux filesystem and PID namespaces, ${network === "none" ? "no network" : "host network explicitly shared"})`);
    const child = spawn("/usr/bin/bwrap", [...args, "--", ...command], { env, stdio: ["inherit", "inherit", "inherit", ...fds] });
    const forward = (signal) => { child.kill(signal); };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    const finish = (code) => {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.exitCode = code;
    };
    child.on("error", (error) => { console.error(`cotal: sandbox could not start: ${error.message}`); finish(1); });
    child.on("exit", (code, signal) => finish(code ?? (signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1)));
  } finally {
    for (const fd of fds) closeSync(fd);
  }
}

try { launch(process.argv.slice(2)); }
catch (error) { console.error(`cotal: sandbox refused: ${error.message}`); process.exitCode = 1; }
