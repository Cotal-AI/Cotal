/**
 * Preset flags and the absent-preset refusal, from metadata only. A boolean option whose schema
 * admits only true, such as the dashboard's explicit read-only intent, gets no `--no-` form, while
 * an ordinary boolean keeps both. A preset no provider declares refuses by name, and `web` names
 * the package that provides it, as `service start web` does.
 *
 * No broker, no provider code and no installed extension: the adapter and preset below are
 * registered in this process.
 *
 * Run: pnpm smoke:service-preset-guidance
 */
import { registry } from "@cotal-ai/core";
import { isCommandFailure, type LocalProcess, type ServicePreset } from "@cotal-ai/workspace";
import { resolveServicePreset, servicePresetFlags } from "../src/lib/service-presets.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};
/** The refusal a call throws, as code, message and remedy, or undefined when it returns. */
const refusal = (fn: () => unknown) => {
  try { fn(); return undefined; }
  catch (error) { return isCommandFailure(error) ? { code: error.code, message: error.message, remedy: error.remedy } : { code: "thrown", message: String(error), remedy: undefined }; }
};

const adapter: LocalProcess = {
  kind: "local-process", name: "guidance-adapter", label: "Guidance adapter", controllerOnly: true, pidFile: "guidance.{space}.pid",
  service: {
    abiVersion: 1, readiness: "process", capabilities: { multiInstance: false, foreground: false, logs: true },
    optionsSchema: { type: "object", additionalProperties: false, required: ["intent"], properties: {
      intent: { type: "boolean", const: true, description: "required explicit intent" },
      pinned: { type: "boolean", enum: [true], description: "an enum that admits only true" },
      toggle: { type: "boolean", description: "an ordinary boolean" },
    } },
  },
};
const preset: ServicePreset = { kind: "service-preset", name: "guidance", adapter: "guidance-adapter", timeoutMs: 1000, summary: "preset flag guidance fixture" };
registry.register(adapter, preset);

const names = servicePresetFlags(preset).map((flag) => flag.name);
check("a boolean whose schema admits only true keeps its flag", names.includes("intent") && names.includes("pinned"), names);
check("...and gets no negative form that could never be valid", !names.includes("no-intent") && !names.includes("no-pinned"), names);
check("an ordinary boolean keeps both forms", names.includes("toggle") && names.includes("no-toggle"), names);

const web = refusal(() => resolveServicePreset("web"));
check("an absent web preset refuses by name", web?.code === "DEPENDENCY_UNAVAILABLE" && web.message.includes('named "web"'), web);
check("...and names the package that provides it", web?.remedy?.includes("cotal ext add @cotal-ai/web") === true, web);
const other = refusal(() => resolveServicePreset("nosuchpreset"));
check("any other absent preset refuses by name with the generic install route", other?.code === "DEPENDENCY_UNAVAILABLE" && other.message.includes('named "nosuchpreset"') && other.remedy?.includes("cotal ext add <package>") === true, other);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
