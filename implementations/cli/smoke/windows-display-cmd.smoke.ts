/**
 * Windows off-PATH display command smoke (no NATS, no test runner): pnpm --filter @cotal-ai/cli test
 *
 * `windowsDisplayCommand` prints the copy-paste prefix for off-PATH Windows installations.
 *
 * - Printable ASCII drive paths without shell expansion characters use `C:"\...\node.exe" "<entry>"`.
 * - Paths with `$`, `%`, `!`, `^`, backticks, quotes, UNC roots, or non-ASCII code units fall back to
 *   `powershell.exe -NoProfile -Command "... #"` with pure-ASCII character codes, zero `$` or `"`
 *   inside the script string, and `[Environment]::GetCommandLineArgs() | Select-Object -Skip 4` so
 *   appended CLI arguments are never re-parsed as PowerShell script.
 * - On Windows, both forms are executed in Restricted PowerShell (interactive prompt parse and
 *   `-Command`) and `cmd.exe` (default and `/v:on` delayed expansion) across spaced/metacharacter
 *   arguments, `--` and `-name` operands, `[1]` wildcard brackets, UNC paths, non-ASCII paths,
 *   non-zero exit codes, and missing executables.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveComspec, windowsShellWord } from "@cotal-ai/workspace";
import { windowsDisplayCommand } from "../src/lib/self-exec.js";

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${label}`, extra === undefined ? "" : JSON.stringify(extra));
  }
}

console.log("1. windowsDisplayCommand formatting invariants");
{
  const primary = windowsDisplayCommand(["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Ada's Dev\\a^b [1]\\cotal.js"]);
  check(
    "printable ASCII drive path with spaces, apostrophe, caret, and brackets uses drive-prefix split quoting",
    primary === `C:"\\Program Files\\nodejs\\node.exe" "C:\\Users\\Ada's Dev\\a^b [1]\\cotal.js"`,
    primary,
  );

  for (const [label, argv] of [
    ["dollar in path", ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\$env\\cotal.js"]],
    ["percent and bang in path", ["C:\\tools\\%TEMP%\\!bang!\\node.exe", "C:\\app\\cotal.js"]],
    ["backtick in path", ["C:\\tools\\a`b\\node.exe", "C:\\app\\cotal.js"]],
    ["UNC path", ["\\\\127.0.0.1\\c$\\Program Files\\nodejs\\node.exe", "C:\\app\\cotal.js"]],
    ["non-ASCII path", ["C:\\Users\\caf\u00e9 \u65e5\u672c\u8a9e\\node.exe", "C:\\Users\\caf\u00e9\\cotal.js"]],
  ] as const) {
    const cmd = windowsDisplayCommand(argv);
    const inner = /^powershell\.exe -NoProfile -Command "([^"]*)"$/.exec(cmd)?.[1];
    check(
      `${label} uses pure-ASCII PowerShell fallback with trailing comment and no outer-shell expanders`,
      inner !== undefined
        && /^[\x20-\x7e]+$/.test(cmd)
        && !/["$`%!^]/.test(inner)
        && inner.includes("Select-Object -Skip 4")
        && inner.endsWith(" #"),
      cmd,
    );
  }
}

if (process.platform === "win32") {
  console.log("2. live Windows shell execution across PowerShell and Command Prompt");
  const sandbox = mkdtempSync(join(tmpdir(), "cotal-win-display-cmd-"));
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const cmdExe = resolveComspec();
  const powershell = join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(?:COTAL_.*|PATH|TEMP|TMP)$/i.test(k))),
    PATH: [join(system, "System32"), dirname(powershell)].join(";"),
    TEMP: sandbox,
    TMP: sandbox,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
  };
  const baseOpts = { cwd: sandbox, env, encoding: "utf8" as const, timeout: 45_000, windowsHide: true };

  const psExitTail = "if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }; if (-not $?) { exit 1 }; exit 0";
  const runPsPrompt = (line: string) =>
    spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Restricted",
        "-EncodedCommand",
        Buffer.from(`$global:LASTEXITCODE = $null\n${line}\n${psExitTail}`, "utf16le").toString("base64"),
      ],
      baseOpts,
    );
  const runPsCommand = (line: string) =>
    spawnSync(
      powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Restricted",
        "-Command",
        `$global:LASTEXITCODE = $null\n${line}\n${psExitTail}`,
      ],
      baseOpts,
    );
  const runCmd = (line: string, delayed = false) =>
    spawnSync(cmdExe, [delayed ? `/v:on /d /s /c "${line}"` : `/d /s /c "${line}"`], {
      ...baseOpts,
      windowsVerbatimArguments: true,
    });

  try {
    const echoScript = [
      'const args = process.argv.slice(2);',
      'console.log(JSON.stringify(args));',
      'const code = args.find((a) => a.startsWith("--exit="));',
      'process.exit(code ? Number(code.slice(7)) : 0);',
    ].join("\n");

    const cases: { label: string; dirName: string; unc?: boolean }[] = [
      { label: "first form with spaces, apostrophe, and [1] brackets", dirName: "Ada's node [1]" },
      { label: "second form with $, %, !, ^, ', and [1]", dirName: "dir $env %TEMP% !bang! ^hat 'quo' [1]" },
      { label: "second form with non-ASCII Unicode", dirName: "caf\u00e9 \u65e5\u672c\u8a9e [1]" },
    ];

    for (const { label, dirName } of cases) {
      const dir = join(sandbox, dirName);
      mkdirSync(dir, { recursive: true });
      const exe = join(dir, "node.exe");
      const entry = join(dir, "echo.js");
      copyFileSync(process.execPath, exe);
      writeFileSync(entry, echoScript, "utf8");
      const prefix = windowsDisplayCommand([exe, entry]);

      // Appended arguments mirroring stack-down, backup, space, use -- -name, and metacharacters.
      const spacedArg = "my space; calc & echo BAD | more";
      const composed = `${prefix} space forget -- -my-space ${windowsShellWord(spacedArg)!} --yes`;
      const wantArgs = JSON.stringify(["space", "forget", "--", "-my-space", spacedArg, "--yes"]);

      for (const [shell, res] of [
        ["Restricted PowerShell prompt", runPsPrompt(composed)],
        ["Restricted PowerShell -Command", runPsCommand(composed)],
        ["cmd.exe", runCmd(composed, false)],
        ["cmd.exe /v:on", runCmd(composed, true)],
      ] as const) {
        check(
          `${label}: preserves exact argv in ${shell}`,
          res.status === 0 && res.stdout.trim() === wantArgs && res.stderr === "",
          { status: res.status, stdout: res.stdout, stderr: res.stderr, composed },
        );
      }

      const failCmd = `${prefix} run --exit=42`;
      const psFail = runPsPrompt(failCmd);
      const cmdFail = runCmd(failCmd);
      check(
        `${label}: propagates non-zero exit code 42 in PowerShell and cmd.exe`,
        psFail.status === 42 && cmdFail.status === 42,
        { ps: psFail.status, cmd: cmdFail.status },
      );
    }

    // UNC path check if administrative loopback share or localhost share resolves this node binary.
    const uncExe = /^([A-Za-z]):\\(.+)$/.exec(process.execPath);
    if (uncExe) {
      const uncPath = `\\\\127.0.0.1\\${uncExe[1]!.toLowerCase()}$\\${uncExe[2]!}`;
      const probe = spawnSync(uncPath, ["--version"], baseOpts);
      if (probe.status === 0) {
        const entry = join(sandbox, "unc-echo.js");
        writeFileSync(entry, echoScript, "utf8");
        const uncCmd = `${windowsDisplayCommand([uncPath, entry])} use -- -unc-space`;
        const wantUnc = JSON.stringify(["use", "--", "-unc-space"]);
        const psUnc = runPsPrompt(uncCmd);
        const cmdUnc = runCmd(uncCmd);
        check(
          "UNC executable path runs in Restricted PowerShell and cmd.exe",
          psUnc.status === 0 && psUnc.stdout.trim() === wantUnc && cmdUnc.status === 0 && cmdUnc.stdout.trim() === wantUnc,
          { psUnc, cmdUnc },
        );
      }
    }

    // Missing executable must exit non-zero in both forms and both shells.
    for (const [formLabel, missingExe] of [
      ["first form", join(sandbox, "missing-plain", "node.exe")],
      ["second form", join(sandbox, "missing $literal", "node.exe")],
    ] as const) {
      const missingCmd = `${windowsDisplayCommand([missingExe, join(sandbox, "missing.js")])} status`;
      const psMissing = runPsPrompt(missingCmd);
      const cmdMissing = runCmd(missingCmd);
      check(
        `${formLabel}: missing executable exits non-zero in PowerShell and cmd.exe`,
        psMissing.status !== 0 && psMissing.status !== null && cmdMissing.status !== 0 && cmdMissing.status !== null,
        { ps: psMissing.status, cmd: cmdMissing.status },
      );
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
