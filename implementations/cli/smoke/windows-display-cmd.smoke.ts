/**
 * Windows off-PATH display command smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `windowsDisplayCommand` prints the copy-paste prefix for off-PATH Windows installations:
 * - Printable ASCII drive executables without `[` or `]` use `C:"\...\node.exe" "<entry>"` when every
 *   argument is accepted by `windowsShellWord` and printable ASCII.
 * - Executable paths containing `[` or `]`, UNC/`\\?\` roots, non-ASCII characters, or shell expanders
 *   (`$`, `%`, `!`, backticks, quotes, trailing `\`) fall back to `powershell.exe -NoProfile -Command "... #"`
 *   using pure-ASCII `[char]` code units, `[WildcardPattern]::Escape(...)` on `&`, and
 *   `@([Environment]::GetCommandLineArgs() | Select-Object -Skip 4)` so appended CLI words are read
 *   verbatim from the OS command line rather than re-parsed as PowerShell script.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { resolveComspec, resolveOnPath, windowsShellWord } from "@cotal-ai/workspace";
import { windowsDisplayCommand } from "../src/lib/self-exec.js";

const { check, finish } = createSuite();

console.log("1. windowsDisplayCommand formatting invariants");
{
  const primary = windowsDisplayCommand([
    "C:\\Program Files\\nodejs\\node.exe",
    "C:\\Users\\Ada's Dev & ( [1]\\cotal.js",
  ]);
  check(
    "printable ASCII drive executable without brackets uses drive-prefix split quoting",
    primary === `C:"\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada's Dev & ( [1]\\cotal.js"`,
    primary,
  );

  for (const [label, argv] of [
    ["brackets in executable path", ["C:\\tools\\node [1]\\node.exe", "C:\\app\\cotal.js"]],
    ["unclosed bracket in executable path", ["C:\\tools\\node [\\node.exe", "C:\\app\\cotal.js"]],
    ["all metacharacters in path", ["C:\\dir $v %TEMP% !b `t 'q & ( [\\node.exe", "C:\\app\\cotal.js"]],
    ["leading dollar in argument", ["C:\\Program Files\\nodejs\\node.exe", "$leading\\cotal.js"]],
    ["UNC path", ["\\\\127.0.0.1\\c$\\Program Files\\nodejs\\node.exe", "C:\\app\\cotal.js"]],
    ["device prefix path", ["\\\\?\\C:\\Program Files\\nodejs\\node.exe", "C:\\app\\cotal.js"]],
    ["non-ASCII and surrogate pair path", ["C:\\Users\\caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80\\node.exe", "C:\\Users\\caf\u00e9\\cotal.js"]],
  ] as const) {
    const cmd = windowsDisplayCommand(argv);
    const inner = /^powershell\.exe -NoProfile -Command "([^"]*)"$/.exec(cmd)?.[1];
    check(
      `${label} uses pure-ASCII PowerShell fallback with WildcardPattern::Escape, @() argv skip, and trailing #`,
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

if (process.platform === "win32") {
  console.log("2. live Windows shell execution across PowerShell and Command Prompt");
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-win-display-cmd-"));
  const toolBin = join(sandbox, "tool-bin");
  mkdirSync(toolBin, { recursive: true });
  const markerFile = join(sandbox, "injected-marker.txt");
  // Harmless marker command on PATH: if `;` or `&` in an appended argument is ever executed as script,
  // `cotalmarker` runs and creates `injected-marker.txt`.
  writeFileSync(join(toolBin, "cotalmarker.cmd"), `@echo ran>"${markerFile}"\r\n`, "ascii");

  const system = process.env.SystemRoot ?? "C:\\Windows";
  const cmdExe = resolveComspec();
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const pwsh = resolveOnPath("pwsh", process.env);
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

  try {
    const echoScript = [
      "const args = process.argv.slice(2);",
      "console.log(JSON.stringify(args));",
      "const code = args.find((a) => a.startsWith('--exit='));",
      "process.exit(code ? Number(code.slice(7)) : 0);",
    ].join("\n");

    // Wildcard sibling decoy for `trap [12]`: if `[12]` were evaluated as a wildcard, PowerShell would
    // match `trap 1\node.exe` (`hostname.exe`) instead of `trap [12]\node.exe`.
    const decoyDir = join(sandbox, "trap 1");
    mkdirSync(decoyDir, { recursive: true });
    const hostnameExe = join(system, "System32", "hostname.exe");
    if (existsSync(hostnameExe)) copyFileSync(hostnameExe, join(decoyDir, "node.exe"));

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

    for (const { label, exeDirName, entryDirName } of installFolders) {
      const exeDir = join(sandbox, exeDirName);
      const entryDir = join(sandbox, entryDirName);
      mkdirSync(exeDir, { recursive: true });
      mkdirSync(entryDir, { recursive: true });
      const exe = join(exeDir, "node.exe");
      const entry = join(entryDir, "echo.js");
      copyFileSync(process.execPath, exe);
      writeFileSync(entry, echoScript, "utf8");
      const prefix = windowsDisplayCommand([exe, entry]);

      const spacedPath = "C:\\My Project\\sub folder";
      const injectionValue = "C:\\My Project; cotalmarker & cotalmarker";
      const invocations: { caseName: string; line: string; want: string[]; checkMarker?: boolean }[] = [
        { caseName: "bare command", line: prefix, want: [] },
        {
          caseName: "quoted path with space",
          line: `${prefix} up --root ${windowsShellWord(spacedPath)!}`,
          want: ["up", "--root", spacedPath],
        },
        {
          caseName: "value with ; and & (marker check)",
          line: `${prefix} backup create ${windowsShellWord(injectionValue)!}`,
          want: ["backup", "create", injectionValue],
          checkMarker: true,
        },
        {
          caseName: "space use -- -dash-space",
          line: `${prefix} space use -- -dash-space`,
          want: ["space", "use", "--", "-dash-space"],
        },
      ];

      for (const { caseName, line, want, checkMarker } of invocations) {
        const wantJson = JSON.stringify(want);
        for (const shell of shells) {
          rmSync(markerFile, { force: true });
          const res = shell.run(line);
          const markerRan = existsSync(markerFile);
          check(
            `${label} -> ${caseName} in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantJson && res.stderr === "" && (!checkMarker || !markerRan),
            { status: res.status, stdout: res.stdout, stderr: res.stderr, markerRan, line },
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

    // UNC path check when loopback administrative share is accessible on this Windows machine.
    const driveMatch = /^([A-Za-z]):\\(.+)$/.exec(process.execPath);
    if (driveMatch) {
      const uncExe = `\\\\127.0.0.1\\${driveMatch[1]!.toLowerCase()}$\\${driveMatch[2]!}`;
      const probe = spawnSync(uncExe, ["--version"], baseOpts);
      if (probe.status === 0) {
        const uncEntry = join(sandbox, "unc-echo.js");
        writeFileSync(uncEntry, echoScript, "utf8");
        const uncCmd = `${windowsDisplayCommand([uncExe, uncEntry])} space use -- -unc-space`;
        const wantUnc = JSON.stringify(["space", "use", "--", "-unc-space"]);
        for (const shell of [shells[1]!, shells[shells.length - 2]!]) {
          const res = shell.run(uncCmd);
          check(
            `UNC executable path runs in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantUnc && res.stderr === "",
            { status: res.status, stdout: res.stdout, stderr: res.stderr },
          );
        }
      } else {
        console.log("  (UNC loopback administrative share unavailable on this host, skipping live UNC exec)");
      }
    }

    // Missing executable must exit non-zero in every shell for both forms (including unclosed `[`).
    for (const [formLabel, missingExe] of [
      ["first form missing executable", join(sandbox, "missing-plain", "node.exe")],
      ["second form missing executable with unclosed [", join(sandbox, "missing $v [", "node.exe")],
    ] as const) {
      const missingLine = `${windowsDisplayCommand([missingExe, join(sandbox, "missing.js")])} status`;
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
