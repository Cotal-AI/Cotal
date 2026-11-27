/**
 * Off-PATH Windows `displayCmd()` and POSIX parity smoke (no NATS, no test runner):
 *   pnpm --filter @cotal-ai/cli test
 *
 * Verifies through `displayCmd()` directly (without adding exports to `@cotal-ai/cli/self-exec`):
 * 1. Windows off-PATH formatting and `SystemRoot` invariants:
 *    - Printable ASCII drive executables without `[` or `]` use `C:"\...\node.exe" "<entry>"` when every
 *      argument is printable ASCII and accepted by `windowsShellWord`, quoting `-name.ext` words so
 *      PowerShell 5.1 does not split them at `.`.
 *    - Executable paths containing `[` or `]`, UNC/`\\?\` roots, non-ASCII characters, or shell expanders
 *      (`$`, `%`, `!`, backticks, quotes, trailing `\`) use
 *      `<Drive>:"\<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -Command "... #"`
 *      when `SystemRoot` resolves to an existing, quotable `powershell.exe`, with parenthesized `@((...),(...))`
 *      elements, pure-ASCII `[char]` code units, `[WildcardPattern]::Escape(...)`, and
 *      `@([Environment]::GetCommandLineArgs() | Select-Object -Skip 4)`.
 *    - When `SystemRoot` is unset, points to a missing `powershell.exe`, or cannot be quoted in first-form
 *      shape, `displayCmd()` falls back to the plain `argv.map(shellWord).join(" ")` command without
 *      inventing an unchecked `C:\Windows` path.
 * 2. POSIX (`linux` and `darwin`) byte-for-byte output parity with `main` across released and checkout
 *    runs, with and without `COTAL_LAUNCHER=1` and `fromAnyFolder: true`.
 * 3. Live Windows shell execution (on `win32`, explicitly logged when skipped elsewhere) across PowerShell 5.1
 *    (default, `Restricted`, `-Command`), `pwsh` when installed, `cmd.exe` (default and `/v:on`), a `.cmd`
 *    batch file, and `Start-Process`, including `cwd\powershell.exe` and `trap 1\node.exe` marker decoys,
 *    first-form `; , = ^ # @ { } ~` paths, multi-argument second-form encoded words in first/middle/last
 *    positions, and live `tsx` source-checkout runs.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import { createSuite } from "@cotal-ai/smoke-kit";
import { resolveComspec, resolveOnPath, windowsShellWord } from "@cotal-ai/workspace";
import { shellWord } from "../src/lib/endpoint-errors.js";
import { displayCmd } from "../src/lib/self-exec.js";

for (const key of Object.keys(process.env)) {
  if (key.startsWith("COTAL_")) delete process.env[key];
}

const { check, finish } = createSuite();
const REPO_ROOT = realpathSync(join(import.meta.dirname, "..", "..", ".."));
const CHECKOUT_ENTRY = realpathSync(join(REPO_ROOT, "bin", "cotal.ts"));

function stageReleasedPackage(baseDir: string, scriptBody = ""): string {
  const pkgDir = join(baseDir, "node_modules", "cotal-ai");
  mkdirSync(join(pkgDir, "dist"), { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name: "cotal-ai", version: "0.0.0-test", type: "module", bin: { cotal: "dist/cotal.js" } }),
    "utf8",
  );
  const entry = join(pkgDir, "dist", "cotal.js");
  writeFileSync(entry, scriptBody, "utf8");
  return realpathSync(entry);
}

function stageCheckoutPackage(checkoutDir: string, scriptBody = "", entryName: "cotal.ts" | "dist/cotal.js" = "dist/cotal.js"): string {
  mkdirSync(join(checkoutDir, "bin", "dist"), { recursive: true });
  writeFileSync(join(checkoutDir, "package.json"), JSON.stringify({ name: "cotal-monorepo", private: true, type: "module" }), "utf8");
  writeFileSync(join(checkoutDir, "pnpm-workspace.yaml"), "packages:\n  - bin\n", "utf8");
  writeFileSync(
    join(checkoutDir, "bin", "package.json"),
    JSON.stringify({ name: "cotal-ai", version: "0.0.0-test", type: "module", bin: { cotal: "dist/cotal.js" } }),
    "utf8",
  );
  const entry = join(checkoutDir, "bin", entryName);
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
  const savedEntries = Object.entries(process.env);
  const hostSysRoot = savedEntries.find(([k]) => k.toLowerCase() === "systemroot")?.[1];
  try {
    Object.defineProperty(process, "platform", { value: opts.platform, configurable: true });
    process.execPath = opts.execPath;
    process.execArgv = opts.execArgv ?? [];
    process.argv = [opts.execPath, opts.entry];
    for (const key of Object.keys(process.env)) {
      if (/^(?:PATH|COTAL_LAUNCHER|SystemRoot|windir|npm_config_.*)$/i.test(key)) delete process.env[key];
    }
    process.env.PATH = "";
    if (opts.platform === "win32") process.env.SystemRoot = hostSysRoot ?? "C:\\Windows";
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
    const keep = new Set(savedEntries.map(([k]) => k));
    for (const key of Object.keys(process.env)) {
      if (!keep.has(key)) delete process.env[key];
    }
    for (const [k, v] of savedEntries) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const origCwd = process.cwd();
const fmtSandbox = mkdtempSync(join(tmpdir(), "cotal-display-cmd-fmt-"));
try {
  process.chdir(fmtSandbox);
  const releasedEntry = stageReleasedPackage(join(fmtSandbox, "rel"));

  // Stage checked System32\WindowsPowerShell\v1.0\powershell.exe targets for formatting invariants.
  let customSysRoot: string;
  let unquotableSysRoot: string;
  if (process.platform === "win32") {
    customSysRoot = join(fmtSandbox, "CustomWinSys");
    unquotableSysRoot = join(fmtSandbox, "Unquotable [1] Win");
    for (const root of [customSysRoot, unquotableSysRoot]) {
      const dir = join(root, "System32", "WindowsPowerShell", "v1.0");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "powershell.exe"), "", "utf8");
    }
  } else {
    customSysRoot = "D:\\WinSys";
    unquotableSysRoot = "C:\\Unquotable [1] Win";
    for (const root of ["C:\\Windows", customSysRoot, unquotableSysRoot]) {
      writeFileSync(join(fmtSandbox, win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")), "", "utf8");
    }
  }

  console.log("1. Windows off-PATH displayCmd() formatting and SystemRoot invariants");
  {
    const primary = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      execArgv: ["-x.y", "--foo.bar", "--import", "C:\\Users\\Ada's Dev & ( [1]\\loader.js"],
      entry: CHECKOUT_ENTRY,
      fromAnyFolder: true,
    });
    const wantEntry = windowsShellWord(CHECKOUT_ENTRY)!;
    const wantEntryFormatted = wantEntry === CHECKOUT_ENTRY && CHECKOUT_ENTRY.startsWith("-") && CHECKOUT_ENTRY.includes(".")
      ? `"${CHECKOUT_ENTRY}"`
      : wantEntry;
    check(
      "printable ASCII drive executable without brackets uses drive-prefix split quoting and quotes -x.y words",
      primary === `C:"\\Program Files\\nodejs\\node.exe" "-x.y" "--foo.bar" --import "C:\\Users\\Ada's Dev & ( [1]\\loader.js" ${wantEntryFormatted}`,
      primary,
    );

    const punctFirst = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\tools ; , = ^ # @ { } ~\\node.exe",
      entry: CHECKOUT_ENTRY,
      fromAnyFolder: true,
    });
    check(
      "printable ASCII path containing ; , = ^ # @ { } ~ uses first form",
      punctFirst === `C:"\\tools ; , = ^ # @ { } ~\\node.exe" ${wantEntryFormatted}`,
      punctFirst,
    );

    const firstWithoutSysRoot = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      entry: CHECKOUT_ENTRY,
      env: { SystemRoot: undefined },
      fromAnyFolder: true,
    });
    check(
      "first form does not depend on SystemRoot when executable and arguments are directly quotable",
      firstWithoutSysRoot === `C:"\\Program Files\\nodejs\\node.exe" ${wantEntryFormatted}`,
      firstWithoutSysRoot,
    );

    const customPsSplit = /^([A-Za-z]:)(.+)$/.exec(win32.join(customSysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))!;
    const customCmd = callDisplayCmd({
      platform: "win32",
      execPath: "C:\\tools\\node [1]\\node.exe",
      entry: CHECKOUT_ENTRY,
      env: { SystemRoot: customSysRoot },
      fromAnyFolder: true,
    });
    check(
      "wrapper resolves verified System32 powershell.exe from SystemRoot in first-form shape",
      customCmd.startsWith(`${customPsSplit[1]}"${customPsSplit[2]}" -NoProfile -Command "`),
      customCmd,
    );

    const bracketExe = "C:\\tools\\node [1]\\node.exe";
    const plainFallback = [bracketExe, CHECKOUT_ENTRY].map(shellWord).join(" ");
    for (const [caseLabel, sysRootVal] of [
      ["unset SystemRoot", undefined],
      ["wrong SystemRoot without powershell.exe", process.platform === "win32" ? join(fmtSandbox, "MissingWinSys") : "C:\\MissingWinSys"],
      ["unquotable SystemRoot with brackets", unquotableSysRoot],
    ] as const) {
      const got = callDisplayCmd({
        platform: "win32",
        execPath: bracketExe,
        entry: CHECKOUT_ENTRY,
        env: { SystemRoot: sysRootVal },
        fromAnyFolder: true,
      });
      check(
        `${caseLabel} prints plain command without inventing an unchecked C:\\Windows path`,
        got === plainFallback,
        got,
      );
    }

    const validSysRoot = process.platform === "win32" ? (process.env.SystemRoot ?? customSysRoot) : "C:\\Windows";
    const validPsSplit = /^([A-Za-z]:)(.+)$/.exec(win32.join(validSysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"))!;
    const validPsPrefix = `${validPsSplit[1]}"${validPsSplit[2]}" -NoProfile -Command "`;

    for (const [label, execPath, execArgv, expectedSnippet] of [
      ["brackets in executable path", "C:\\tools\\node [1]\\node.exe", [], "@(("],
      ["unclosed bracket in executable path", "C:\\tools\\node [\\node.exe", [], "@(("],
      ["all metacharacters in path", "C:\\dir $v %TEMP% !b `t 'q & ( [\\node.exe", [], "@(("],
      [
        "leading dollar in argument",
        "C:\\Program Files\\nodejs\\node.exe",
        ["$leading\\loader.js"],
        "@((''+[char]36+'leading\\loader.js'),(",
      ],
      [
        "encoded words in first, middle, and last arguments",
        "C:\\Program Files\\nodejs\\node.exe",
        ["$first\\a.js", "C:\\mid%20dle\\b.js"],
        "@((''+[char]36+'first\\a.js'),('C:\\mid'+[char]37+'20dle\\b.js'),(",
      ],
      ["consecutive special chars at start", "C:\\Program Files\\nodejs\\node.exe", ["$$double\\loader.js"], "@((''+[char]36+[char]36+'double\\loader.js'),("],
      ["UNC path", "\\\\127.0.0.1\\c$\\Program Files\\nodejs\\node.exe", [], "@(("],
      ["device prefix path", "\\\\?\\C:\\Program Files\\nodejs\\node.exe", [], "@(("],
      ["non-ASCII and surrogate pair path", "C:\\Users\\caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80\\node.exe", ["C:\\Users\\caf\u00e9\\loader.js"], "[char]55357+[char]56960"],
    ] as const) {
      const cmd = callDisplayCmd({
        platform: "win32",
        execPath,
        execArgv: [...execArgv],
        entry: CHECKOUT_ENTRY,
        env: { SystemRoot: validSysRoot },
        fromAnyFolder: true,
      });
      const inner = cmd.startsWith(validPsPrefix) && cmd.endsWith('"')
        ? cmd.slice(validPsPrefix.length, -1)
        : undefined;
      check(
        `${label} uses verified System32 PowerShell wrapper with parenthesized @((...)) elements, WildcardPattern::Escape, and trailing #`,
        inner !== undefined
          && /^[\x20-\x7e]+$/.test(cmd)
          && !/["$`%!^]/.test(inner)
          && inner.includes(expectedSnippet)
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
  process.chdir(origCwd);
  rmSync(fmtSandbox, { recursive: true, force: true });
}

if (process.platform !== "win32") {
  console.log(`3. SKIPPED live Windows shell and UNC execution cells on ${process.platform}: requires win32 System32 powershell.exe and cmd.exe`);
} else {
  console.log("3. live Windows shell execution across PowerShell, Command Prompt, .cmd batch, Start-Process, multi-arg, and source runs");
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-win-display-cmd-"));
  const toolBin = join(sandbox, "tool-bin");
  mkdirSync(toolBin, { recursive: true });
  const markerFile = join(sandbox, "injected-marker.txt");
  const bracketDecoyMarker = join(sandbox, "bracket-decoy-marker.txt");
  const cwdPsDecoyMarker = join(sandbox, "cwd-ps-decoy-marker.txt");
  writeFileSync(join(toolBin, "cotalmarker.cmd"), `@echo ran>"${markerFile}"\r\n`, "ascii");

  const system = process.env.SystemRoot ?? "C:\\Windows";
  const cmdExe = resolveComspec();
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const pwsh = resolveOnPath("pwsh", process.env);
  if (!pwsh) {
    console.log("  SKIPPED pwsh outer-shell cells: PowerShell 7 (pwsh) is not installed on PATH on this Windows host");
  }
  const cleanEntries = Object.entries(process.env).filter(([k]) => !k.startsWith("COTAL_") && !/^(?:PATH|TEMP|TMP)$/i.test(k));
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(cleanEntries),
    PATH: [toolBin, join(system, "System32"), dirname(powershell)].join(delimiter),
    SystemRoot: system,
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

  const csc = join(system, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  function buildMarkerExe(outExe: string, targetMarker: string): void {
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
    console.log(
      `  SKIPPED marker-file decoy compilation for ${outExe}: csc.exe unavailable on this host, falling back to hostname.exe (stdout/exit check only)`,
    );
    copyFileSync(join(system, "System32", "hostname.exe"), outExe);
  }

  function buildArgvDumpExe(outExe: string): string | undefined {
    if (!existsSync(csc)) return undefined;
    const csFile = `${outExe}.cs`;
    writeFileSync(
      csFile,
      [
        "using System;",
        "using System.Text;",
        "class A {",
        "  static string Esc(string s) {",
        "    var b = new StringBuilder(\"\\\"\");",
        "    foreach (char c in s) {",
        "      if (c == '\\\\') b.Append(\"\\\\\\\\\");",
        "      else if (c == '\"') b.Append(\"\\\\\\\"\");",
        "      else if (c < 0x20) b.AppendFormat(\"\\\\u{0:x4}\", (int)c);",
        "      else b.Append(c);",
        "    }",
        "    return b.Append('\"').ToString();",
        "  }",
        "  static int Main() {",
        "    var a = Environment.GetCommandLineArgs();",
        "    var parts = new string[a.Length - 1];",
        "    for (int i = 1; i < a.Length; i++) parts[i - 1] = Esc(a[i]);",
        "    Console.WriteLine(\"[\" + string.Join(\",\", parts) + \"]\");",
        "    return 0;",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );
    const compiled = spawnSync(csc, ["/nologo", `/out:${outExe}`, csFile], baseOpts);
    rmSync(csFile, { force: true });
    return compiled.status === 0 && existsSync(outExe) ? outExe : undefined;
  }

  try {
    const echoScript = [
      "const args = process.argv.slice(2);",
      "console.log(JSON.stringify(args));",
      "const code = args.find((a) => a.startsWith('--exit='));",
      "process.exit(code ? Number(code.slice(7)) : 0);",
    ].join("\n");

    const decoyDir = join(sandbox, "trap 1");
    mkdirSync(decoyDir, { recursive: true });
    buildMarkerExe(join(decoyDir, "node.exe"), bracketDecoyMarker);
    buildMarkerExe(join(sandbox, "powershell.exe"), cwdPsDecoyMarker);
    writeFileSync(join(sandbox, "powershell.cmd"), `@echo ran>"${cwdPsDecoyMarker}"\r\n@exit /b 99\r\n`, "ascii");

    const installFolders: { label: string; exeDirName: string; entryDirName: string }[] = [
      {
        label: "first form (' & ( in path, [1] in entry)",
        exeDirName: "Ada's & ( runtime",
        entryDirName: "Ada's & ( [1] pkg",
      },
      {
        label: "first form (; , = ^ # @ { } ~ in exe and entry paths)",
        exeDirName: "semi ; , = ^ # @ { } ~ exe",
        entryDirName: "semi ; , = ^ # @ { } ~ pkg",
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
        label: "non-ASCII and astral Unicode path",
        exeDirName: "caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80 [1]",
        entryDirName: "caf\u00e9 \u65e5\u672c\u8a9e \ud83d\ude80 [1]",
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

    // Multi-argument second-form execution: encoded word in first, middle, and last position, plus leading `$`
    // and `-x.y` in `execArgv` (verifies `@((...),(...))` precedence and received argv in both shells).
    {
      const fullArgvScript = "console.log(JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(1) }));\n";
      const plainCheckout = stageCheckoutPackage(join(sandbox, "multi-plain"), fullArgvScript);
      const bangCheckout = stageCheckoutPackage(join(sandbox, "multi-last !end"), fullArgvScript);
      const multiCases = [
        {
          name: "encoded word in first position",
          execArgv: ["--conditions=$first", "--conditions=plain2"],
          entry: plainCheckout,
        },
        {
          name: "encoded word in middle position",
          execArgv: ["--conditions=plain1", "--conditions=mid%20dle"],
          entry: plainCheckout,
        },
        {
          name: "encoded word in last position",
          execArgv: ["--conditions=plain1", "--conditions=plain2"],
          entry: bangCheckout,
        },
        {
          name: "encoded words in first, middle, and last positions",
          execArgv: ["--conditions=$first", "--conditions=mid%20dle"],
          entry: bangCheckout,
        },
      ];
      for (const mc of multiCases) {
        const prefix = callDisplayCmd({
          platform: "win32",
          execPath: process.execPath,
          execArgv: mc.execArgv,
          entry: mc.entry,
          fromAnyFolder: true,
        });
        const wantPayload = JSON.stringify({ execArgv: mc.execArgv, argv: [mc.entry, "status", "--foo.bar"] });
        for (const shell of [shells[0]!, shells[1]!, shells[shells.length - 2]!]) {
          const res = shell.run(`${prefix} status --foo.bar`);
          check(
            `multi-arg second form (${mc.name}) delivers exact execArgv and argv in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantPayload && res.stderr === "",
            { status: res.status, stdout: res.stdout, stderr: res.stderr, prefix },
          );
        }
      }

      const argvDump = buildArgvDumpExe(join(sandbox, "argv-dump.exe"));
      if (argvDump) {
        // Leading `$` at index 0 of `args` (`$leading\loader.js`) + `-x.y` in both first and second forms.
        const leadDollarCmd = callDisplayCmd({
          platform: "win32",
          execPath: argvDump,
          execArgv: ["$leading\\loader.js", "-x.y"],
          entry: plainCheckout,
          fromAnyFolder: true,
        });
        const wantLeadDollar = JSON.stringify(["$leading\\loader.js", "-x.y", plainCheckout, "status"]);
        for (const shell of [shells[0]!, shells[1]!, shells[shells.length - 2]!]) {
          const res = shell.run(`${leadDollarCmd} status`);
          check(
            `leading dollar in argument executes and delivers exact argv in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantLeadDollar && res.stderr === "",
            { status: res.status, stdout: res.stdout, stderr: res.stderr, leadDollarCmd },
          );
        }

        const firstDotCmd = callDisplayCmd({
          platform: "win32",
          execPath: argvDump,
          execArgv: ["-x.y", "--require", "C:\\plain\\preflight.cjs"],
          entry: plainCheckout,
          fromAnyFolder: true,
        });
        const wantFirstDot = JSON.stringify(["-x.y", "--require", "C:\\plain\\preflight.cjs", plainCheckout, "status"]);
        for (const shell of [shells[0]!, shells[1]!, shells[shells.length - 2]!]) {
          const res = shell.run(`${firstDotCmd} status`);
          check(
            `first-form source run with -x.y in execArgv delivers unsplit -x.y in ${shell.name}`,
            res.status === 0 && res.stdout.trim() === wantFirstDot && res.stderr === "",
            { status: res.status, stdout: res.stdout, stderr: res.stderr, firstDotCmd },
          );
        }
      } else {
        console.log("  SKIPPED compiled argv-dump.exe leading-dollar/-x.y cells: csc.exe unavailable on this host");
      }
    }

    // Real `tsx` Windows source runs (`PlainCheckout\bin\cotal.ts` first form and `Spaced Checkout\bin\cotal.ts` second form).
    {
      const tsxPkgReal = realpathSync(join(REPO_ROOT, "node_modules", "tsx"));
      const esbuildPkgReal = realpathSync(join(dirname(tsxPkgReal), "esbuild"));
      const selfExecUrl = JSON.stringify(`file:///${join(REPO_ROOT, "implementations", "cli", "src", "lib", "self-exec.ts").replaceAll("\\", "/")}`);
      for (const [checkoutLabel, folderName] of [
        ["plain Windows tsx source checkout (first form)", "PlainCheckout"],
        ["spaced Windows tsx source checkout (second form)", "Spaced Checkout"],
      ] as const) {
        const checkoutDir = join(sandbox, folderName);
        cpSync(dirname(tsxPkgReal), join(checkoutDir, "node_modules"), { recursive: true, dereference: true });
        cpSync(join(dirname(esbuildPkgReal), "@esbuild"), join(checkoutDir, "node_modules", "@esbuild"), {
          recursive: true,
          dereference: true,
        });
        const tsEntry = stageCheckoutPackage(
          checkoutDir,
          [
            `import { displayCmd } from ${selfExecUrl};`,
            "if (process.argv[2] === 'emit-prefix') {",
            "  console.log(JSON.stringify({ prefix: displayCmd({ fromAnyFolder: true }), execArgv: process.execArgv }));",
            "} else {",
            "  console.log(JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(1) }));",
            "}",
          ].join("\n"),
          "cotal.ts",
        );
        const tsxCli = join(checkoutDir, "node_modules", "tsx", "dist", "cli.mjs");
        const emitted = spawnSync(process.execPath, ["--conditions=dev.local", tsxCli, tsEntry, "emit-prefix"], baseOpts);
        check(`${checkoutLabel} emits displayCmd({ fromAnyFolder: true }) under real tsx`, emitted.status === 0, {
          status: emitted.status,
          stdout: emitted.stdout,
          stderr: emitted.stderr,
        });
        if (emitted.status === 0) {
          const { prefix: sourcePrefix, execArgv: tsxExecArgv } = JSON.parse(emitted.stdout.trim()) as {
            prefix: string;
            execArgv: string[];
          };
          const wantSource = JSON.stringify({
            execArgv: tsxExecArgv,
            argv: [tsEntry, "status", "--foo.bar"],
          });
          for (const shell of [shells[0]!, shells[1]!, shells[shells.length - 2]!]) {
            const res = shell.run(`${sourcePrefix} status --foo.bar`);
            check(
              `${checkoutLabel} prefix re-runs bin/cotal.ts with exact execArgv and argv in ${shell.name}`,
              res.status === 0 && res.stdout.trim() === wantSource && res.stderr === "",
              { status: res.status, stdout: res.stdout, stderr: res.stderr, sourcePrefix },
            );
          }
        }
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
    if (!driveMatch) {
      console.log(
        `  SKIPPED live UNC cell: process.execPath (${process.execPath}) has no drive letter to map to a loopback administrative share`,
      );
    } else {
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
