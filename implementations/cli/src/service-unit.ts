import { registry } from "@cotal-ai/core";
import { serviceUnitEntry } from "./commands/service-unit-entry.js";

/** Registers the hidden `__service-unit` entry, the one a unit `service install` wrote runs. It is a
 *  module of its own so that a composition root can load it without the rest of the CLI. */
registry.register(serviceUnitEntry);
