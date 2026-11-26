// The plugin's one hooks module: Claude Code loads a single entry per plugin, and allows one hook
// per event and matcher across everything that entry imports.
import { register as registerCommands } from './commands.js';
import { register as registerStream } from './stream.js';
import { register as registerWake } from './native-wake.js';

export function register(on) {
  registerWake(on);
  registerCommands(on);
  registerStream(on);
}
