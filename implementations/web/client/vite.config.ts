/// <reference types="node" />
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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
      const bundled = [...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, root]) => {
        const meta = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string; license?: string };
        if (!meta.version || !meta.license) throw new Error(`bundle-licenses: ${name} declares no version or license`);
        return { package: name, version: meta.version, license: meta.license };
      });
      this.emitFile({ type: "asset", fileName: "bundle-licenses.json", source: JSON.stringify({ bundled }, null, 2) + "\n" });
    },
  };
}

export default defineConfig({
  root: here,
  base: "/",
  plugins: [react(), bundleLicenses()],
  build: {
    outDir: resolve(here, "../dist/web"),
    emptyOutDir: true,
    assetsDir: "assets",
    target: "es2022",
    sourcemap: false,
    modulePreload: { polyfill: false },
  },
});
