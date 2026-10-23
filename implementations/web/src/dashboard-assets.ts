import { readdirSync, statSync } from "node:fs";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
};

/** Enumerate packaged Astro output once. Request paths only index this allow-list. */
export function loadDashboardPages(): Record<string, { path: string; type: string }> {
  // src/ and dist/ are siblings, so this resolves the same artifact in source and installed runs.
  const root = fileURLToPath(new URL("../dist/ui/", import.meta.url));
  const dashboard = join(root, "index.html");
  if (!statSync(dashboard).isFile()) throw new Error("dashboard is not a file; run the web build");
  const pages: Record<string, { path: string; type: string }> = Object.create(null);
  pages["/"] = { path: dashboard, type: "text/html; charset=utf-8" };
  const assets = join(root, "dashboard-assets");
  for (const entry of readdirSync(assets, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    const path = join(entry.parentPath, entry.name);
    const type = MIME[extname(entry.name)];
    if (!entry.isFile() || !type) throw new Error(`unsupported dashboard asset: ${path}`);
    const route = "/dashboard-assets/" + relative(assets, path).split(sep).join("/");
    pages[route] = { path, type };
  }
  return pages;
}
