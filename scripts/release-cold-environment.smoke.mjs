import assert from "node:assert/strict";
import { coldOsEnvironment } from "./release-cold-environment.mjs";

const os = {
  Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows", windir: "C:\\Windows", SystemDrive: "C:",
  ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".EXE;.CMD", OS: "Windows_NT",
  PROCESSOR_ARCHITECTURE: "ARM64", PROCESSOR_ARCHITEW6432: "AMD64", NUMBER_OF_PROCESSORS: "4",
  ALLUSERSPROFILE: "C:\\ProgramData", ProgramData: "C:\\ProgramData", ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)", ProgramW6432: "C:\\Program Files",
  CommonProgramFiles: "C:\\Program Files\\Common Files", "CommonProgramFiles(x86)": "C:\\Program Files (x86)\\Common Files", CommonProgramW6432: "C:\\Program Files\\Common Files",
  PUBLIC: "C:\\Users\\Public", LANG: "en_US.UTF-8", LC_ALL: "C", CI: "true",
};
const source = Object.freeze({ ...os, HOME: "warm-home", USERPROFILE: "warm-profile", APPDATA: "warm-roaming", LOCALAPPDATA: "warm-local", TEMP: "warm-temp", TMP: "warm-temp", TMPDIR: "warm-temp", PSModulePath: "warm-user-modules", COTAL_HOME: "operator-state", COTAL_TOKEN: "fixture-secret", OPENAI_API_KEY: "fixture-secret", GITHUB_TOKEN: "fixture-secret", NPM_TOKEN: "fixture-secret" });
assert.deepEqual(coldOsEnvironment(source, "win32"), { ...os, PSModulePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules" }, "cold Windows env preserves only OS roots and system modules");
console.log("PASS cold Windows env preserves only OS roots and system modules");
assert.deepEqual(coldOsEnvironment({ PATH: "/usr/bin", LANG: "C", CI: "true", HOME: "/warm", COTAL_HOME: "/operator", OPENAI_API_KEY: "fixture-secret" }, "linux"), { PATH: "/usr/bin", LANG: "C", CI: "true" }, "cold POSIX env excludes personal state and credentials");
console.log("PASS cold POSIX env excludes personal state and credentials");
assert.throws(() => coldOsEnvironment({ Path: "C:\\Windows" }, "win32"), /requires the host SystemRoot/, "cold Windows env refuses missing OS foundation");
console.log("PASS cold Windows env refuses missing OS foundation");
console.log("SUITE COMPLETE: 3 passed, 0 failed; synthetic environment controls only");
