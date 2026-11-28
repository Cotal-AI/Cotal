import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, tmpdir, join, boot, check, cotal, freshCfg, HOST_ENV, seedDir, listNames, track, finishScenario } from "./harness.js";

try {
  // Stop root discovery in this private home instead of reading the runner's ancestors.
  mkdirSync(join(process.cwd(), ".cotal"), { recursive: true });
  // ── a seed that fails is reported as a failure, with its reason, and --repair finishes it ─────────
  {
    const cfg = track(freshCfg());
    // `node` and nothing else on PATH, so the seed child's `npm install` cannot start.
    const bin = track(mkdtempSync(join(tmpdir(), "cotal-seed-no-npm-")));
    symlinkSync(process.execPath, join(bin, "node"));
    const noNpm = { PATH: bin };
    for (let attempt = 0; attempt < 2; attempt++) {
      const attach = cotal(cfg, ["attach", "missing"], noNpm);
      check("attach without npm: resolves the target without seeding on a fresh machine",
        attach.status === 1 && /no space is registered or prepared here/.test(attach.stderr) && !/connector seed|Reconciling built-in/.test(attach.stderr), attach.stderr);
      check("attach without npm: writes neither the seed store nor the extensions prefix",
        !existsSync(seedDir(cfg)) && !existsSync(join(cfg, "cotal", "extensions")));
    }
    const first = boot(cfg, noNpm);
    check("failed seed: the boot fails", first.status !== 0, first.stderr);
    check("failed seed: the reason follows the colon on the failure line",
      /failed to seed connector "claude" from \S+: @cotal-ai\/connector-claude-code npm install failed: npm is not on PATH/.test(first.stderr) && !first.stderr.includes("\\u000a") && !first.stderr.includes("spawn npm ENOENT"), first.stderr);
    const next = cotal(cfg, ["space", "create", "after-failure", "--root", track(mkdtempSync(join(tmpdir(), "cotal-failed-seed-")))], noNpm);
    check("failed seed: the next boot reports the failure and its reason, not an interruption",
      next.status !== 0 && /a previous connector seed failed \(package "claude", phase add\): failed to seed connector "claude"/.test(next.stderr) && /cotal ext seed --repair/.test(next.stderr) && !/interrupted/.test(next.stderr), next.stderr);
    const cursor = join(seedDir(cfg), "reconcile.cursor.json");
    const failedCursor = readFileSync(cursor, "utf8");
    const create = ["space", "create", "audit-retry"];
    const json = cotal(cfg, [...create, "--json"], noNpm);
    const failure = JSON.parse(json.stdout);
    const diagnosis = /a previous connector seed failed \(package "claude", phase add\).*npm is not on PATH/;
    check("failed seed: space create JSON reports the retained dependency refusal",
      json.status === 2 && json.stderr === "" && failure.outcome === "refused" &&
        failure.error?.code === "DEPENDENCY_UNAVAILABLE" && diagnosis.test(failure.error.message), json);
    for (const flags of [["--plain"], []]) {
      const retry = cotal(cfg, [...create, ...flags], noNpm);
      check(`failed seed: space create ${flags[0] ?? "text"} reports the same dependency refusal and exits 2`,
        retry.status === 2 && retry.stdout === "" && retry.stderr.includes("DEPENDENCY_UNAVAILABLE") &&
          diagnosis.test(retry.stderr) && retry.stderr.includes("ext seed --repair") &&
          (!flags.length || !retry.stderr.includes("✗")), retry);
    }
    check("failed seed: the retries prepare no space and leave the failed cursor untouched",
      !existsSync(join(HOST_ENV.COTAL_HOME!, "prepared")) && readFileSync(cursor, "utf8") === failedCursor);
    for (const args of [["attach", "missing"], ["attach", "missing"], ["stop", "missing"], ["input", "missing", "hello"]]) {
      const control = cotal(cfg, args, noNpm);
      const expectedExit = args[0] === "input" ? 2 : 1;
      check(`${args[0]} after failed seed: reaches target resolution without connector repair`,
        control.status === expectedExit && /no space is registered or prepared here/.test(control.stderr) && !/connector seed|Reconciling built-in/.test(control.stderr),
        { status: control.status, stderr: control.stderr });
      check(`${args[0]} after failed seed: leaves the failed seed record unchanged`, readFileSync(cursor, "utf8") === failedCursor);
    }
    const repair = cotal(cfg, ["ext", "seed", "--repair"]);
    check("failed seed: --repair with npm back exits 0", repair.status === 0 && /recovering from a failed seed \(package "claude"\)/.test(repair.stderr), repair.stderr);
    check("failed seed: --repair installed the failed connector", listNames(cfg).includes("claude"));
    check("failed seed: the cursor is cleared after the verified install", !existsSync(join(seedDir(cfg), "reconcile.cursor.json")));
  }
} finally {
  finishScenario();
}
