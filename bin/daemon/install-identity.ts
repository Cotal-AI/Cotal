import { readFileSync, realpathSync } from "node:fs";
import { CommandFailure } from "@cotal-ai/workspace/local-observation";
import type { ServiceMechanism, UnitReceipt } from "./install.js";

/** Whether the verified source carries the installer-owned native launch marker. */
export function recordedSourceMarked(receipt: UnitReceipt, mechanism: ServiceMechanism): boolean {
  const source = readFileSync(receipt.unitPath).toString(mechanism === "scheduled-task" ? "utf16le" : "utf8");
  return mechanism === "systemd-user" ? source.includes("Environment=COTAL_DAEMON_NATIVE_SERVICE=1")
    : mechanism === "launchd-agent" ? source.includes("<key>COTAL_DAEMON_NATIVE_SERVICE</key><string>1</string>")
    : source.includes("daemon-native.js") || (source.includes("cotal-desktop.exe</Command>") && source.includes("<Arguments>--daemon"));
}

/** Compare the verified source's executable and entry with the caller's immutable launch coordinates. */
export function recordedSourceIdentity(receipt: UnitReceipt, mechanism: ServiceMechanism, expected: readonly string[] | (() => readonly string[])): { same: boolean; installed: string; current: string } {
  const bytes = readFileSync(receipt.unitPath);
  const decode = (value: string) => value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&amp;", "&");
  let argv: string[];
  if (mechanism === "systemd-user") {
    const line = /^ExecStart=(.*)$/m.exec(bytes.toString("utf8"))?.[1];
    if (!line) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon unit has no readable executable and entry");
    argv = [...line.matchAll(/"((?:\\.|[^"\\])*)"|([^\s"]+)/g)].map(match => (match[1] ?? match[2]!).replace(/\\([\\"])/g, "$1").replaceAll("%%", "%").replaceAll("$$", "$"));
  } else if (mechanism === "launchd-agent") {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(bytes.toString("utf8"))?.[1] ?? "";
    argv = [...array.matchAll(/<string>([^<]*)<\/string>/g)].map(match => decode(match[1]!));
  } else {
    const text = bytes.subarray(2).toString("utf16le");
    const executable = decode(/<Command>([^<]*)<\/Command>/.exec(text)?.[1] ?? "");
    const args = decode(/<Arguments>([^<]*)<\/Arguments>/.exec(text)?.[1] ?? "");
    argv = [executable, ...[...args.matchAll(/"([^"]*)"|(\S+)/g)].map(match => match[1] ?? match[2]!)];
  }
  const coordinate = (args: readonly string[]) => {
    const daemon = args.indexOf("daemon");
    const entry = daemon >= 2 ? args[daemon - 1]! : args[0]!;
    return { executable: args[0], entry };
  };
  const installed = coordinate(argv), current = coordinate(typeof expected === "function" ? expected() : expected);
  if (mechanism === "launchd-agent") installed.entry = argv[argv.indexOf("daemon") - 2]!.replace(/daemon-cwd\.js$/, "cotal.js");
  if (mechanism === "scheduled-task") installed.entry = installed.entry.replace(/daemon-native\.js$/, "cotal.js");
  if (!installed.executable || !installed.entry) throw new CommandFailure("refused", "CONFLICT", "the recorded daemon installation could not be identified");
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return path; } };
  return { same: canonical(installed.executable) === canonical(current.executable!) && canonical(installed.entry) === canonical(current.entry), installed: `${installed.executable} ${installed.entry}`, current: `${current.executable} ${current.entry}` };
}
