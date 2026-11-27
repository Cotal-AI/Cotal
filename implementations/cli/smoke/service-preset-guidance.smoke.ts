/**
 * Preset flags and the absent-preset refusal, from metadata only. A boolean option whose schema
 * admits only true, such as the dashboard's explicit read-only intent, gets no `--no-` form, while
 * an ordinary boolean keeps both. An absent preset refuses by name. A library root without web
 * does not recommend installing the dashboard separately.
 *
 * No broker, no provider code and no installed extension: the adapter and preset below are
 * registered in this process.
 *
 * Run: pnpm smoke:service-preset-guidance
 */
import { registry } from "@cotal-ai/core";
import { isCommandFailure, type LocalProcess, type ServicePreset } from "@cotal-ai/workspace";
import { resolveServicePreset, servicePresetDefinition, servicePresetFlags } from "../src/lib/service-presets.js";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish, passed, failed } = createSuite();
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
check("...and lists the available presets without dashboard installation advice", web?.remedy?.includes("cotal svc") === true && !web.remedy.includes("ext add"), web);
const other = refusal(() => resolveServicePreset("nosuchpreset"));
check("any other absent preset refuses by name with the generic install route", other?.code === "DEPENDENCY_UNAVAILABLE" && other.message.includes('named "nosuchpreset"') && other.remedy?.includes("cotal ext add <package>") === true, other);

// A manager launch is a private native spec pinned by its full digest, so saving one of the two
// flags alone is refused and saves nothing, while the pair together defines the launch.
const managerAdapter: LocalProcess = {
  kind: "local-process", name: "manager-service", label: "Manager service", controllerOnly: true, pidFile: "manager.{space}.pid",
  service: {
    abiVersion: 1, readiness: "process", capabilities: { multiInstance: false, foreground: true, logs: true },
    optionsSchema: { type: "object", additionalProperties: false, required: ["root", "runtime"], properties: {
      root: { type: "string", minLength: 1, maxLength: 4096, description: "registered mesh root" },
      runtime: { type: "string", minLength: 1, maxLength: 200, description: "explicit installed runtime" },
      launch: { type: "string", minLength: 1, maxLength: 4096, description: "existing private resolved native launch spec" },
      "launch-sha256": { type: "string", minLength: 64, maxLength: 64, description: "full SHA-256 of the exact resolved launch file; required with launch" },
    } },
  },
};
const managerPreset: ServicePreset = { kind: "service-preset", name: "manager", adapter: "manager-service", timeoutMs: 60000, summary: "manager fixture", defaults: { root: { space: "root" }, runtime: { value: "pty" } } };
registry.register(managerAdapter, managerPreset);
const digest = "a".repeat(64);
const managerAdd = (values: Record<string, string>) => refusal(() => servicePresetDefinition(managerPreset, "space", values, "/root", "add manager"));
const loneLaunch = managerAdd({ launch: "/root/launch.json" });
check("a manager add with --launch alone refuses USAGE_INVALID naming --launch-sha256",
  loneLaunch?.code === "USAGE_INVALID" && loneLaunch.message.startsWith("--launch requires --launch-sha256 <digest>:") === true
    && loneLaunch.remedy === "cotal service add manager --preset manager --launch <file> --launch-sha256 <digest>", loneLaunch);
const loneDigest = managerAdd({ "launch-sha256": digest });
check("a manager add with --launch-sha256 alone refuses USAGE_INVALID naming --launch",
  loneDigest?.code === "USAGE_INVALID" && loneDigest.message.startsWith("--launch-sha256 requires --launch <file>:") === true
    && loneDigest.remedy === "cotal service add manager --preset manager --launch <file> --launch-sha256 <digest>", loneDigest);
const paired = (() => { try { return servicePresetDefinition(managerPreset, "space", { launch: "/root/launch.json", "launch-sha256": digest }, "/root", "add manager"); } catch (error) { return error; } })();
check("a manager add with both launch flags defines the launch",
  !(paired instanceof Error) && (paired as { launch: { options: Record<string, unknown> } }).launch.options.launch === "/root/launch.json"
    && (paired as { launch: { options: Record<string, unknown> } }).launch.options["launch-sha256"] === digest, paired);
const neither = (() => { try { return servicePresetDefinition(managerPreset, "space", {}, "/root", "add manager"); } catch (error) { return error; } })();
check("a manager add with neither launch flag still defines the service",
  !(neither instanceof Error) && (neither as { launch: { options: Record<string, unknown> } }).launch.options.launch === undefined, neither);

console.log(`\n${passed()} passed, ${failed()} failed`);
finish();
process.exit(failed() ? 1 : 0);
