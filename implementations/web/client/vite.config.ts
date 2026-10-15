/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { bootTheme } from "./src/lib/themeBoot.ts";

const here = dirname(fileURLToPath(import.meta.url));

/** The package root and name for a bundled module path, taken from its last `node_modules/`
 *  segment so pnpm's `.pnpm/<name>@<v>/node_modules/<name>` layout resolves to the real package. */
function packageOf(id: string): { name: string; root: string } | undefined {
  const m = /^(.*[\\/]node_modules[\\/])((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  return m ? { name: m[2].replace(/\\/g, "/"), root: m[1] + m[2] } : undefined;
}

/** Writes `bundle-licenses.json`: every third-party package compiled into the client, with the
 *  version and license its own package.json declares, found from the module ids of the emitted
 *  chunks (stylesheet imports included). A package with no license fails the build. */
function bundleLicenses(): Plugin {
  return {
    name: "cotal-bundle-licenses",
    generateBundle(_options, bundle) {
      const found = new Map<string, string>();
      for (const out of Object.values(bundle)) {
        if (out.type !== "chunk") continue;
        const ids = (out as { moduleIds?: string[] }).moduleIds ?? Object.keys(out.modules);
        for (const id of ids) {
          const p = packageOf(id);
          if (p) found.set(p.name, p.root);
        }
      }
      // Code-unit order, the same plain comparison the client-build suite checks with: a
      // locale-aware sort could order two names differently on another machine.
      const bundled = [...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, root]) => {
        const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string; license?: string };
        if (!meta.version || !meta.license) throw new Error(`bundle-licenses: ${name} declares no version or license`);
        return { package: name, version: meta.version, license: meta.license };
      });
      this.emitFile({ type: "asset", fileName: "bundle-licenses.json", source: JSON.stringify({ bundled }, null, 2) + "\n" });
    },
  };
}

/** The theme boot script: `bootTheme` (src/lib/themeBoot.ts) as a classic script, run on the page's
 *  own storage and root element. */
const THEME_BOOT_JS = `(${bootTheme.toString()})(() => localStorage, document.documentElement);\n`;

/** Writes `theme-boot.js` beside the page and puts it first in the page's head, ahead of the
 *  stylesheet and the module script the build adds. The stylesheet blocks the first paint and the
 *  module script is deferred, so only a classic script placed before the stylesheet can put the saved
 *  theme on the root element in time. It loads from the page's own origin and is never inlined, so
 *  the page can keep a `script-src 'self'` policy. The dev server answers it too. */
function themeBoot(): Plugin {
  return {
    name: "cotal-theme-boot",
    transformIndexHtml: () => [{ tag: "script", attrs: { src: "/theme-boot.js" }, injectTo: "head-prepend" }],
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "theme-boot.js", source: THEME_BOOT_JS });
    },
    configureServer(server) {
      server.middlewares.use("/theme-boot.js", (_req, res) => {
        res.setHeader("content-type", "text/javascript; charset=utf-8");
        res.end(THEME_BOOT_JS);
      });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), bundleLicenses(), themeBoot()],
  build: {
    outDir: resolve(here, "../dist/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
