import { readFileSync, writeFileSync } from 'node:fs';
if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Invalid-input installer control requires a disposable runner.');
const source = readFileSync('desktop/src-tauri/installers/hooks.nsh', 'utf8');
const anchor = '"$PLUGINSDIR\\setup-node.exe" "$PLUGINSDIR\\service-update.mjs" prepare';
if (source.split(anchor).length !== 2) throw new Error('Prepare invocation is not singular.');
writeFileSync('desktop/src-tauri/installers/invalid-helper.nsh', source.replace(anchor, '"$PLUGINSDIR\\nonexistent-helper.exe" "$PLUGINSDIR\\service-update.mjs" prepare'));
