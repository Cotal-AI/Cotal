// A tiny fixture PR used by `--mock` runs and the smoke test, so neither needs network or model
// quota. The planted defects line up with the canned mock findings (src/auth.ts:42, src/cache.ts:17).
import type { PrPacket } from "../contracts.js";

export const SAMPLE_PR: PrPacket = {
  prUrl: "https://github.com/example/repo/pull/1",
  title: "Add token rotation and a write-through cache",
  body: "Rotates auth tokens on refresh and caches the lookup. Follow-up to #0.",
  patch: `diff --git a/src/auth.ts b/src/auth.ts
@@ -38,6 +38,9 @@ export function rotate(tokens: string[]) {
-  for (let i = 0; i < tokens.length; i++) {
+  for (let i = 0; i <= tokens.length; i++) {
     tokens[i] = mint(tokens[i]);
   }
diff --git a/src/cache.ts b/src/cache.ts
@@ -14,5 +14,7 @@ export async function lookup(id: string) {
+  cache.set(id, row);
+  await db.commit();
   return row;
diff --git a/src/util.ts b/src/util.ts
@@ -1,3 +1,4 @@
+export const noop = () => {};
`,
  maxFindings: 8,
};
