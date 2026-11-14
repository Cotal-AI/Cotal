import { isCotalCloudIdp } from "./model";

export interface UpdateStatus {
  channel?: "desktop" | "npm";
  current: string;
  latest?: string;
  lastCheck?: string;
  lastResult: string;
  automatic: boolean;
  notify?: boolean;
}

export function lastChecked(value: string | undefined, now = new Date()): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "Not checked yet";
  const date = new Date(value);
  const time = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(date);
  return date.toDateString() === now.toDateString() ? `Last checked today at ${time}` : `Last checked ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)} at ${time}`;
}

export function accountHost(provider: string | undefined): string {
  if (!provider) return "No account selected";
  const host = new URL(provider).host;
  return isCotalCloudIdp(provider) ? `Cotal Cloud, ${host}` : host;
}

const repository = "https://github.com/Cotal-AI/Cotal";
const versionPattern = /^\d+\.\d+\.\d+$/;

export function newerVersion(latest: string | undefined, current: string): boolean {
  if (!latest || !versionPattern.test(latest) || !versionPattern.test(current)) return false;
  const a = latest.split(".").map(Number), b = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

export function releaseUrl(version: string): string {
  if (!versionPattern.test(version)) throw new Error("The release version is unsupported.");
  return `${repository}/releases/tag/v${version}`;
}

/** Asset names match the desktop release workflow. Availability still requires release evidence. */
export function installerName(version: string, platform: string, arch: string): string | undefined {
  releaseUrl(version);
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) return `Cotal_${version}_${arch === "arm64" ? "aarch64" : "x64"}.dmg`;
  if (platform === "win32" && arch === "x64") return `Cotal_${version}_x64-setup.exe`;
  if (platform === "linux" && arch === "x64") return `Cotal_${version}_amd64.deb`;
  return undefined;
}

export function installerLink(version: string, platform: string, arch: string, assets: readonly { name: string; url: string }[]): { url: string; label: string; available: boolean } {
  const page = releaseUrl(version);
  const name = installerName(version, platform, arch);
  const asset = assets.find(item => item.name === name && item.url === `${repository}/releases/download/v${version}/${name}`);
  return asset ? { url: asset.url, label: "Download update", available: true } : { url: page, label: "Open release page", available: false };
}

export function updateNotice(status: UpdateStatus | undefined, appVersion: string, dismissed?: string): string | undefined {
  return status?.channel === "desktop" && status.notify !== false && newerVersion(status.latest, appVersion) && status.latest !== dismissed ? status.latest : undefined;
}

export function updatePolicy(channel: UpdateStatus["channel"], platform: string, appConfigured = false): { label: string; description: string } {
  if (appConfigured) return { label: "Install updates automatically", description: "Cotal downloads verified desktop updates when automatic updates are on. Installation waits until it can run safely." };
  if (channel === "desktop") return { label: "Notify me about updates", description: "Cotal tells you here when a new version is out. Installing it updates the app and its background service." };
  if (channel === "npm" && platform === "linux") return { label: "Install updates automatically", description: "The background service updates itself for Linux npm installs. This does not replace a desktop app bundle." };
  return { label: "Notify me about updates", description: "Automatic installation is unavailable for this installation. Install a new version yourself." };
}

export function updateSummary(status: UpdateStatus | undefined, current: string): string {
  if (!status) return "Update information is unavailable.";
  if (newerVersion(status.latest, current)) return `Version ${status.latest} is available.`;
  if (status.lastResult.includes("failed")) return "The update check failed. Try again.";
  return status.lastCheck ? "You are up to date." : "Updates have not been checked yet.";
}
