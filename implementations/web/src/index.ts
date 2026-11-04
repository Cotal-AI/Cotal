import { registry } from "@cotal-ai/core";
import { webProcess } from "./web.js";
import "./service-adapter.js";

// Keep the old process observation/removal descriptor for existing instances. New launches use
// the service preset; importing this package no longer registers a competing web command.
registry.register(webProcess);
