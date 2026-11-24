/**
 * This machine's identity as its operating system records it: `/etc/machine-id` on Linux, the
 * hardware UUID on macOS, and on Windows the system ID Windows derives for this publisher
 * (GetSystemIdForPublisher). The ID names the machine to anyone who reads it, so a caller publishes
 * only a hash of it.
 */
import { readFileSync } from "node:fs";
import { darwinProcessBinding } from "./darwin-process.js";
import { win32ProcessBinding } from "./win32-process.js";

/** The modules Windows derives a system ID from (SystemIdentificationSource 1, 2 and 3). */
export type Win32SystemIdSource = "tpm" | "uefi" | "registry";
export const SYSTEM_ID_SOURCES: readonly Win32SystemIdSource[] = ["tpm", "uefi", "registry"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The bytes that identify this machine. On Windows, `source` is the module Windows derived the
 *  system ID from, undefined when it names none of the three. */
export type OsMachineId = { bytes: Buffer } & ({ platform: "win32"; source: Win32SystemIdSource | undefined } | { platform: "linux" | "darwin" });

/** Read this machine's OS identity. Throws on another platform, and when the read fails or returns
 *  a malformed ID. */
export function osMachineId(): OsMachineId {
  if (process.platform === "win32") {
    const system = win32ProcessBinding().systemId();
    if (!/^(?:[0-9a-f]{2}){1,256}$/.test(system.id) || !Number.isInteger(system.source)) throw new Error("Windows returned a malformed system ID");
    return { platform: "win32", bytes: Buffer.from(system.id, "hex"), source: SYSTEM_ID_SOURCES[system.source - 1] };
  }
  if (process.platform === "darwin") {
    const { machine } = darwinProcessBinding().hostIdentity();
    if (!UUID.test(machine)) throw new Error("macOS returned a malformed hardware UUID");
    return { platform: "darwin", bytes: Buffer.from(machine.toLowerCase()) };
  }
  if (process.platform === "linux") {
    const machine = readFileSync("/etc/machine-id", "utf8").trim();
    if (!/^[0-9a-f]{32}$/i.test(machine)) throw new Error("/etc/machine-id holds no machine ID");
    return { platform: "linux", bytes: Buffer.from(machine.toLowerCase()) };
  }
  throw new Error(`${process.platform} has no machine identity that Cotal reads`);
}
