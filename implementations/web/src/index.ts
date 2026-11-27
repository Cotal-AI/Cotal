import { registry } from "@cotal-ai/core";
import { webProcess } from "./registration.js";
import "./service-adapter.js";

// Direct process observation uses the PID descriptor. New launches use the service preset.
registry.register(webProcess);
