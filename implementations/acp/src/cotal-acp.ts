#!/usr/bin/env node
/** The `cotal-acp` executable `npx @cotal-ai/acp` runs. */
import { launch } from "./launcher.js";

process.exitCode = await launch(process.argv.slice(2));
