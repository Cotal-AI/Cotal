import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";
import { dashboardDevProxy } from "./scripts/dev-proxy.mjs";

export default defineConfig({
  srcDir: "./ui",
  publicDir: "./ui/public",
  outDir: "./dist/ui",
  output: "static",
  build: { assets: "dashboard-assets" },
  integrations: [react()],
  server: { host: "127.0.0.1" },
  vite: { plugins: [tailwindcss(), dashboardDevProxy()] },
});
