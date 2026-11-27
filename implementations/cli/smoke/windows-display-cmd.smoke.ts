/**
 * Off-PATH Windows `displayCmd()` and POSIX parity smoke (no NATS, no test runner):
 *   pnpm --filter @cotal-ai/cli test
 *
 * Verifies through `displayCmd()` directly (without adding exports to `@cotal-ai/cli/self-exec`):
 * 1. Windows off-PATH formatting invariants:
 *    - Printable ASCII drive executables without `[` or `]` use `C:"\...\node.exe" "<entry>"` when every
 *      argument is printable ASCII and accepted by `windowsShellWord`.
 *    - Executable paths containing `[` or `]`, UNC/`\\?\` roots, non-ASCII characters, or shell expanders
 *      (`$`, `%`, `!`, backticks, quotes, trailing `\`) fall back to
 *      `C:"\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "... #"` (resolved
 *      from `SystemRoot`, never `PATH`) using pure-ASCII `[char]` code units, `[WildcardPattern]::Escape(...)`,
 *      and `@([Environment]::GetCommandLineArgs() | Select-Object -Skip 4)`.
 * 2. POSIX (`linux` and `darwin`) byte-for-byte output parity with `main` across released and checkout
 *    runs, with and without `COTAL_LAUNCHER=1` and `fromAnyFolder: true`.
 * 3. Live Windows shell execution (on `win32`, explicitly logged when skipped elsewhere) across PowerShell 5.1
 *    (default, `Restricted`, `-Command`), `pwsh` when installed, `cmd.exe` (default and `/v:on`), a `.cmd`
 *    batch file, and `Start-Process`, including `cwd\powershell.exe` and `trap 1\node.exe` marker decoys.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { resolveComspec, resolveOnPath, windowsShellWord } from "@cotal-ai/workspace";
import { shellWord } from "../src/lib/endpoint-errors.js";
import { displayCmd } from "../src/lib/self-exec.js";

const { check, finish } = createSuite();
const REPO_ROOT = realpathSync(join(import.meta.dirname, "..", "..", ".."));
const CHECKOUT_ENTRY = realpathSync(join(REPO_ROOT, "bin", "cotal.ts"));

function stageReleasedPackage(baseDir: string, scriptBody = ""): string {
  const pkgDir = join(baseDir, "node_modules", "cotal-ai");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "cotal-ai", version: "0.0.0-test", bin: { cotal: "dist/cotal.js" } }),
    "utf8",
  );
  const entry = join(pkgDir, "dist", "cotal.js");
  writeFileSync(entry, scriptBody, "utf8");
  return realpathSync(entry);
}

function callDisplayCmd(opts: {
  platform: NodeJS.Platform;
  execPath: string;
  execArgv?: string[];
  entry: string;
  env?: Record<string, string | undefined>;
  fromAnyFolder?: boolean;
}): string {
  const origPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const origExecPath = process.execPath;
  const origExecArgv = process.execArgv;
  const origArgv = process.argv;
  const savedEnv = { ...process.env };
  try {
    Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
    process.execPath = opts.execPath;
    process.execArgv = opts.execArgv ?? [];
    process.argv = [opts.execPath, opts.entry];
    for (const key of Object.keys(process.env)) {
      if (/^(?:PATH|COTAL_LAUNCHER|SystemRoot|windir|npm_config_.*)$/i.test(key)) delete process.env[key];
    }
    process.env.PATH = "";
    if (opts.platform === "win32") process.env.SystemRoot = savedEnv.SystemRoot ?? "C:\\Windows";
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return displayCmd({ fromAnyFolder: opts.fromAnyFolder ?? false });
  } finally {
    Object.defineProperty(process, "platform", origPlatform);
    process.execPath = origExecPath;
    process.execArgv = origExecArgv;
    process.argv = origArgv;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  }
}

const fmtSandbox = mkdtempSync(join(tmpdir(), "cotal-display-cmd-fmt-"));
try {
  const releasedEntry = stageReleasedPackage(join(fmtSandbox, "rel"));

  console.log("1. Windows off-PATH displayCmd() formatting invariants");
  {
    const primary = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      execArgv: ["C:\\Users\\Ada's Dev & ( [1]\\loader.js"],
      entry: CHECKOUT_ENTRY,
      fromAnyFolder: true,
    });
    const wantEntry = windowsShellWord(CHECKOUT_ENTRY)!;
    check(
      "printable ASCII drive executable without brackets uses drive-prefix split quoting",
      primary === `C:"\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada's Dev & ( [1]\\loader.js" ${wantEntry}`,
      primary,
    );

    const customSysRoot = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\tools\\node [1]\\node.exe",
      entry: CHECKOUT_ENTRY,
      env: { SystemRoot: "D:\\WinSys" },
      fromAnyFolder: true,
    });
    check(
      "wrapper resolves absolute System32 powershell.exe from SystemRoot in first-form shape (never PATH)",
      customSysRoot.startsWith(`D:"\\WinSys\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "`),
      customSysRoot,
    );

    for (const [label, execPath, execArgv] of [
      ["brackets in executable path", "C:\\tools\\node [1]\\node.exe", []],
      ["unclosed bracket in executable path", "C:\\tools\\node [\\node.exe", []],
      ["all metacharacters in path", "C:\\dir $v %TEMP% !b `t 'q & ( [\\node.exe", []],
      ["leading dollar in argument", "C:\\Program Files\\nodejs\\node.exe", ["$leading\\loader.js"]],
      ["consecutive special chars at start", "C:\\Program Files\\nodejs\\node.exe", ["$$double\\loader.js"]],
      ["UNC path", "\\\\127.0.0.1\\c$\\Program Files\\nodejs\\node.exe", []],
      ["device prefix path", "\\\\?\\C:\\Program Files\\nodejs\\node.exe", []],
      ["non-ASCII and surrogate pair path", "C:\\Users\\caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80\\node.exe", ["C:\\Users\\caf\u00e9\\loader.js"]],
    ] as const) {
      const cmd = callDisplayCmd({
        platform: "win32",
        execPath,
        execArgv: [...execArgv],
        entry: CHECKOUT_ENTRY,
        env: { SystemRoot: "C:\\Windows" },
        fromAnyFolder: true,
      });
      const inner = /^C:"\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" -NoProfile -Command "([^"]*)"$/.exec(cmd)?.[1];
      check(
        `${label} uses absolute System32 PowerShell fallback with WildcardPattern::Escape, @() argv skip, and trailing #`,
        inner !== undefined
          && /^[\x20-\x7e]+$/.test(cmd)
          && !/["$`%!^]/.test(inner)
          && inner.includes("[WildcardPattern]::Escape(")
          && inner.includes("@([Environment]::GetCommandLineArgs() | Select-Object -Skip 4)")
          && inner.endsWith(" #"),
        cmd,
      );
    }
  }

  console.log("2. POSIX displayCmd() byte-for-byte parity with main");
  for (const platform of ["linux", "darwin"] as const) {
    const posixNode = "/opt/node's bin/node";
    const releasedPlain = callDisplayCmd({ platform, execPath: posixNode, entry: releasedEntry });
    check(
      `${platform}: released off-PATH without COTAL_LAUNCHER matches main byte-for-byte`,
      releasedPlain === [posixNode, releasedEntry].map(shellWord).join(" "),
      releasedPlain,
    );

    const prefix = "/opt/cotal's prefix";
    const releasedLauncher = callDisplayCmd({
      platform,
      execPath: posixNode,
      entry: releasedEntry,
      env: { COTAL_LAUNCHER: "1", npm_config_prefix: prefix },
    });
    const wantCmd = [posixNode, releasedEntry].map(shellWord).join(" ");
    const wantLauncher = `PATH=${shellWord(join(prefix, "nodebin"))}:"$PATH" npm_config_prefix=${shellWord(prefix)} COTAL_LAUNCHER=1 ${wantCmd}`;
    check(
      `${platform}: released off-PATH with COTAL_LAUNCHER=1 matches main byte-for-byte`,
      releasedLauncher === wantLauncher,
      releasedLauncher,
    );

    const checkoutDefault = callDisplayCmd({
      platform,
      execPath: posixNode,
      execArgv: ["--import", "tsx"],
      entry: CHECKOUT_ENTRY,
      fromAnyFolder: false,
    });
    check(`${platform}: checkout default returns pnpm cotal`, checkoutDefault === "pnpm cotal", checkoutDefault);

    const checkoutAnyFolder = callDisplayCmd({
      platform,
      execPath: posixNode,
      execArgv: ["--import", "tsx"],
      entry: CHECKOUT_ENTRY,
      env: { COTAL_LAUNCHER: "1", npm_config_prefix: prefix },
      fromAnyFolder: true,
    });
    check(
      `${platform}: checkout fromAnyFolder ignores COTAL_LAUNCHER and matches main byte-for-byte`,
      checkoutAnyFolder === [posixNode, "--import", "tsx", CHECKOUT_ENTRY].map(shellWord).join(" "),
      checkoutAnyFolder,
    );
  }
} finally {
  rmSync(fmtSandbox, { recursive: true, force: true });
}

if (process.platform !== "win32") {
  console.log(`3. SKIPPED live Windows shell and UNC execution cells on ${process.platform}: requires win32 System32 powershell.exe and cmd.exe`);
} else {
  console.log("3. live Windows shell execution across PowerShell, Command Prompt, .cmd batch, and Start-Process");
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-win-display-cmd-"));
  const toolBin = join(sandbox, "tool-bin");
  mkdirSync(toolBin, { recursive: true });
  const markerFile = join(sandbox, "injected-marker.txt");
  const bracketDecoyMarker = join(sandbox, "bracket-decoy-marker.txt");
  const cwdPsDecoyMarker = join(sandbox, "cwd-ps-decoy-marker.txt");
  // Harmless marker command on PATH: if `;`, `&`, or `#>` in an appended argument is ever executed as script,
  // `cotalmarker` runs and creates `injected-marker.txt`.
  writeFileSync(join(toolBin, "cotalmarker.cmd"), `@echo ran>"${markerFile}"\r\n`, "ascii");

  const system = process.env.SystemRoot ?? "C:\\Windows";
  const cmdExe = resolveComspec();
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const pwsh = resolveOnPath("pwsh", process.env);
  if (!pwsh) {
    console.log("  SKIPPED pwsh outer-shell cells: PowerShell 7 (pwsh) is not installed on PATH on this Windows host");
  }
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:COTAL_.*|PATH|TEMP|TMP)$/i.test(k))),
    PATH: [toolBin, join(system, "System32"), dirname(powershell)].join(delimiter),
    TEMP: sandbox,
    TMP: sandbox,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
  const baseOpts = { cwd: sandbox, env, encoding: "utf8" as const, timeout: 45_000, windowsHide: true };

  const psExitTail = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }; exit 0";
  const runPs = (exe: string, policy: "Default" | "Restricted", mode: "prompt" | "command") => (line: string) => {
    const policyArgs = policy === "Restricted" ? ["-ExecutionPolicy", "Restricted"] : [];
    const script = `$global:LASTEXITCODE = $null\n${line}\n${psExitTail}`;
    const args = mode === "prompt"
      ? ["-NoProfile", "-NonInteractive", ...policyArgs, "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]
      : ["-NoProfile", "-NonInteractive", ...policyArgs, "-Command", script];
    return spawnSync(exe, args, baseOpts);
  };
  const runCmd = (delayed: boolean) => (line: string) =>
    spawnSync(cmdExe, [delayed ? `/v:on /d /s /c "${line}"` : `/d /s /c "${line}"`], {
      ...baseOpts,
      windowsVerbatimArguments: true,
    });

  const shells: { name: string; run: (line: string) => SpawnSyncReturns<string> }[] = [
    { name: "PS 5.1 default", run: runPs(powershell, "Default", "prompt") },
    { name: "PS 5.1 Restricted", run: runPs(powershell, "Restricted", "prompt") },
    { name: "PS 5.1 -Command", run: runPs(powershell, "Restricted", "command") },
    ...(pwsh ? [{ name: "pwsh", run: runPs(pwsh, "Default", "prompt") }] : []),
    { name: "cmd.exe", run: runCmd(false) },
    { name: "cmd.exe /v:on", run: runCmd(true) },
  ];

  function buildMarkerExe(outExe: string, targetMarker: string): void {
    const csc = join(system, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    if (existsSync(csc)) {
      const csFile = `${outExe}.cs`;
      const escaped = targetMarker.replaceAll("\\", "\\\\");
      writeFileSync(
        csFile,
        `class P { static int Main() { System.IO.File.WriteAllText("${escaped}", "ran"); return 99; } }\n`,
        "utf8",
      );
      const compiled = spawnSync(csc, ["/nologo", `/out:${outExe}`, csFile], baseOpts);
      rmSync(csFile, { force: true });
      if (compiled.status === 0 && existsSync(outExe)) return;
    }
    copyFileSync(join(system, "System32", "hostname.exe"), outExe);
  }

  try {
    const echoScript = [
      "const args = process.argv.slice(2);",
      "console.log(JSON.stringify(args));",
      "const code = args.find((a) => a.startsWith('--exit='));",
      "process.exit(code ? Number(code.slice(7)) : 0);",
    ].join("\n");

    // 1. Wildcard sibling decoy for `trap [12]\node.exe`: if `[12]` were unescaped, PowerShell would match
    //    `trap 1\node.exe` and write `bracket-decoy-marker.txt`.
    const decoyDir = join(sandbox, "trap 1");
    mkdirSync(decoyDir, { recursive: true });
    buildMarkerExe(join(decoyDir, "node.exe"), bracketDecoyMarker);

    // 2. Current-directory `powershell.exe` / `powershell.cmd` decoy in `cwd = sandbox`: if the second form
    //    printed an unqualified `powershell.exe`, `cmd.exe` would run `sandbox\powershell.exe` first.
    buildMarkerExe(join(sandbox, "powershell.exe"), cwdPsDecoyMarker);
    writeFileSync(join(sandbox, "powershell.cmd"), `@echo ran>"${cwdPsDecoyMarker}"\r\n@exit /b 99\r\n`, "ascii");

    const installFolders: { label: string; exeDirName: string; entryDirName: string }[] = [
      {
        label: "first form (' & ( in path, [1] in entry)",
        exeDirName: "Ada's & ( runtime",
        entryDirName: "Ada's & ( [1] pkg",
      },
      {
        label: "second form ($, %, !, `, ', &, (, unclosed [, space)",
        exeDirName: "dir $v %TEMP% !b `t 'q & ( [ end",
        entryDirName: "dir $v %TEMP% !b `t 'q & ( [ end",
      },
      {
        label: "bracket wildcard-trap executable (trap [12] beside trap 1)",
        exeDirName: "trap [12]",
        entryDirName: "trap [12]",
      },
      {
        label: "non-ASCII Unicode path",
        exeDirName: "caf\u00e9 \u65e5\u672c\u8a9e [1]",
        entryDirName: "caf\u00e9 \u65e5\u672c\u8a9e [1]",
      },
    ];

    let secondFormPrefix = "";
    for (const { label, exeDirName, entryDirName } of installFolders) {
      const exeDir = join(sandbox, exeDirName);
      const entryDir = join(sandbox, entryDirName);
      mkdirSync(exeDir, { recursive: true });
      mkdirSync(entryDir, { recursive: true });
      const exe = join(exeDir, "node.exe");
      copyFileSync(process.execPath, exe);
      const entry = stageReleasedPackage(entryDir, echoScript);
      const prefix = callDisplayCmd({ platform: "win32", execPath: exe, entry });
      if (label.startsWith("second form")) secondFormPrefix = prefix;

      const spacedPath = "C:\\Users\\me\\share$\\My Project";
      const injectionValue = "C:\\My Project; cotalmarker & cotalmarker #> cotalmarker";
      const invocations: { caseName: string; line: string; want: string[]; checkMarker?: boolean }[] = [
        { caseName: "bare command", line: prefix, want: [] },
        {
          caseName: "quoted path with space and $\\",
          line: `${prefix} up --root "${spacedPath}"`,
          want: ["up", "--root", spacedPath],
        },
        {
          caseName: "value with ;, &, and #> (marker check)",
          line: `${prefix} backup create ${windowsShellWord(injectionValue)!}`,
          want: ["backup", "create", injectionValue],
          checkMarker: true,
        },
        {
          caseName: "use -- -dash-space",
          line: `${prefix} use -- -dash-space`,
          want: ["use", "--", "-dash-space"],
        },
      ];

      for (const { caseName, line, want, checkMarker } of invocations) {
        const wantJson = JSON.stringify(want);
        for (const shell of shells) {
          rmSync(markerFile, { force: true });
          rmSync(bracketDecoyMarker, { force: true });
          rmSync(cwdPsDecoyMarker, { force: true });
          const res = shell.run(line);
          const markerRan = existsSync(markerFile);
          const bracketDecoyRan = existsSync(bracketDecoyMarker);
          const cwdPsDecoyRan = existsSync(cwdPsDecoyMarker);
          check(
            `${label} -> ${caseName} in ${shell.name}`,
            res.status === 0
              && res.stdout.trim() === wantJson
              && res.stderr === ""
              && !bracketDecoyRan
              && !cwdPsDecoyRan
              && (!checkMarker || !markerRan),
            { status: res.status, stdout: res.stdout, stderr: res.stderr, markerRan, bracketDecoyRan, cwdPsDecoyRan, line },
          );
        }
      }

      for (const shell of [shells[0]!, shells[shells.length - 2]!]) {
        const failRes = shell.run(`${prefix} run --exit=42`);
        check(
          `${label} -> exit code 42 in ${shell.name}`,
          failRes.status === 42,
          { status: failRes.status, stdout: failRes.stdout, stderr: failRes.stderr },
        );
      }
    }

    // Batch (.cmd) file and Start-Process checks on the second form (`Select-Object -Skip 4` invariant).
    {
      const wantBatch = JSON.stringify(["--version", "C:\\Users\\me\\share$\\My Project", "foo #> cotalmarker", "--", "-dash"]);
      const tailArgs = '--version "C:\\Users\\me\\share$\\My Project" "foo #> cotalmarker" -- -dash';
      const batPath = join(sandbox, "invoke-second.cmd");
      writeFileSync(batPath, `@echo off\r\n${secondFormPrefix} ${tailArgs}\r\n`, "ascii");
      rmSync(markerFile, { force: true });
      rmSync(cwdPsDecoyMarker, { force: true });
      const batRes = runCmd(false)(`"${batPath}"`);
      check(
        "second form preserves exact argv from .cmd batch file without running #> or cwd powershell.exe decoy",
        batRes.status === 0
          && batRes.stdout.trim() === wantBatch
          && batRes.stderr === ""
          && !existsSync(markerFile)
          && !existsSync(cwdPsDecoyMarker),
        { status: batRes.status, stdout: batRes.stdout, stderr: batRes.stderr },
      );

      const spOut = join(sandbox, "sp-out.txt");
      const firstSpace = secondFormPrefix.indexOf(" ");
      const restOfCmd = `${secondFormPrefix.slice(firstSpace + 1)} ${tailArgs}`;
      const spScript = `$p = Start-Process -FilePath '${powershell}' -ArgumentList $env:COTAL_SP_ARGS -NoNewWindow -Wait -PassThru -RedirectStandardOutput '${spOut}'; Get-Content '${spOut}'; exit $p.ExitCode`;
      const spRes = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", spScript], {
        ...baseOpts,
        env: { ...env, COTAL_SP_ARGS: restOfCmd },
      });
      check(
        "second form preserves exact argv through Start-Process System32 powershell.exe",
        spRes.status === 0 && spRes.stdout.trim() === wantBatch && spRes.stderr === "",
        { status: spRes.status, stdout: spRes.stdout, stderr: spRes.stderr },
      );
    }

    // UNC path check when loopback administrative share is accessible on this Windows machine.
    const driveMatch = /^([A-Za-z]):\\(.+)$/.exec(process.execPath);
    if (driveMatch) {
      const uncExe = `\\\\127.0.0.1\\${driveMatch[1]!.toLowerCase()}$\\${driveMatch[2]!}`;
      const probe = spawnSync(uncExe, ["--version"], baseOpts);
      if (probe.status === 0) {
        const uncEntry = stageReleasedPackage(join(sandbox, "unc-pkg"), echoScript);
        const uncCmd = `${callDisplayCmd({ platform: "win32", execPath: uncExe, entry: uncEntry })} use -- -unc-space`;
        const wantUnc = JSON.stringify(["use", "--", "-unc-space"]);
        for (const shell of [shells[1]!, shells[shells.length - 2]!]) {
          const res = shell.run(uncCmd);
          check(
            `UNC executable path runs in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantUnc && res.stderr === "",
            { status: res.status, stdout: res.stdout, stderr: res.stderr },
          );
        }
      } else {
        console.log(
          `  SKIPPED live UNC cell: loopback administrative share ${uncExe} is unavailable on this host (status=${String(probe.status)})`,
        );
      }
    }

    // Missing executable must exit non-zero in every shell for both forms (including unclosed `[`).
    const validEntry = stageReleasedPackage(join(sandbox, "missing-pkg"), echoScript);
    for (const [formLabel, missingExe] of [
      ["first form missing executable", join(sandbox, "missing-plain", "node.exe")],
      ["second form missing executable with unclosed [", join(sandbox, "missing $v [", "node.exe")],
    ] as const) {
      const missingLine = `${callDisplayCmd({ platform: "win32", execPath: missingExe, entry: validEntry })} status`;
      for (const shell of [shells[0]!, shells[1]!, shells[shells.length - 2]!]) {
        const res = shell.run(missingLine);
        check(
          `${formLabel} exits non-zero in ${shell.name}`,
          res.status !== 0 && res.status !== null,
          { status: res.status, stdout: res.stdout, stderr: res.stderr },
        );
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

finish();
