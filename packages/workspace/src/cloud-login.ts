import { spawn } from "node:child_process";

/** Hosted deployment auth base. Custom providers retain their own auth URLs. */
export const COTAL_CLOUD_IDP = "https://cotal.cloud/api/auth";

/** The Cloud origin is an explicit alias, never a discovery or retry rule for other hosts. */
export function cloudAuthUrl(url: string): string {
  if (url === "https://cloud.cotal.ai" || url === "https://cloud.cotal.ai/") return "https://cloud.cotal.ai/api/auth";
  return url === "https://cotal.cloud" || url === "https://cotal.cloud/" ? COTAL_CLOUD_IDP : url;
}

/** Recognize hosted Cloud auth bases without accepting other paths or providers. */
export function isCotalCloudIdp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.username && !parsed.password
      && !parsed.port && !parsed.search && !parsed.hash
      && (parsed.hostname === "cotal.cloud" || parsed.hostname === "cloud.cotal.ai")
      && (parsed.pathname === "/api/auth" || parsed.pathname === "/api/auth/");
  } catch { return false; }
}

/** The recovery command for a refused sign-in, without deployment details for Cloud. */
export function loginRecoveryCommand(idpUrl: string): string {
  return cloudAuthUrl(idpUrl.replace(/\/$/, "")) === COTAL_CLOUD_IDP ? "cotal login" : `cotal login --idp ${idpUrl}`;
}

/** Decide the native browser command without launching it, including for smoke assertions. */
export function loginBrowserCommand(url: string, options: {
  terminal: boolean;
  json: boolean;
  noBrowser: boolean;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}): { command: string; args: string[] } | undefined {
  if (!options.terminal || options.json || options.noBrowser) return undefined;
  const parsed = new URL(url);
  if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password)
    throw new Error("the approval link must be an HTTP(S) URL without embedded credentials");
  if (options.platform === "linux") {
    if (!options.env.DISPLAY && !options.env.WAYLAND_DISPLAY) return undefined;
    return { command: "xdg-open", args: [url] };
  }
  if (options.platform === "darwin") return { command: "open", args: [url] };
  if (options.platform === "win32") {
    if (/[\r\n"%!^&|<>]/.test(url)) throw new Error("the approval link contains unsupported browser command characters");
    return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] };
  }
  return undefined;
}

/** Keep the printed approval usable if the desktop opener fails. Never print its arguments. */
export function openLoginBrowser(url: string, values: Record<string, unknown>): void {
  let launch: ReturnType<typeof loginBrowserCommand>;
  try { launch = loginBrowserCommand(url, {
    terminal: Boolean(process.stdout.isTTY), json: values.json === true,
    noBrowser: values["no-browser"] === true, platform: process.platform, env: process.env,
  }); }
  catch { console.error("Could not open your browser. Open the printed approval link on any device."); return; }
  if (!launch) return;
  const child = spawn(launch.command, launch.args, { stdio: "ignore", windowsHide: true });
  child.once("error", () => console.error("Could not open your browser. Open the printed approval link on any device."));
  child.once("exit", code => { if (code) console.error("The browser opener failed. Open the printed approval link on any device."); });
  child.unref();
}
