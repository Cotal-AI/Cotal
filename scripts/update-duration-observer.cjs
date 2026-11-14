// Measurement-only preload. Original calls, arguments, results and output pass through unchanged.
const fs = require('node:fs');
const cp = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { performance } = require('node:perf_hooks');
const path = require('node:path');
const root = process.env.UPDATE_TIMING_DIR;
if (root) {
  const append = fs.appendFileSync.bind(fs);
  const file = path.join(root, `${process.pid}.jsonl`);
  const clock = () => performance.timeOrigin + performance.now();
  const record = event => append(file, JSON.stringify({ pid: process.pid, ppid: process.ppid, ...event }) + '\n');
  const stack = () => new Error().stack.split('\n').slice(3).join('\n');
  record({ kind: 'process-start', at: clock(), command: process.argv, node: process.version });
  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = cp[name];
    cp[name] = function (...args) {
      const at = clock();
      const id = `${process.pid}:${at}:${name}`;
      record({ kind: 'child-start', id, api: name, at, command: args[0], args: Array.isArray(args[1]) ? args[1] : [], stack: stack() });
      try {
        const result = Reflect.apply(original, this, args);
        if (name.endsWith('Sync')) record({ kind: 'child-end', id, at: clock(), status: result?.status ?? 0, error: result?.error?.message });
        else {
          result.once('error', error => record({ kind: 'child-error', id, at: clock(), error: error.message }));
          result.once('close', (status, signal) => record({ kind: 'child-end', id, at: clock(), childPid: result.pid, status, signal }));
        }
        return result;
      } catch (error) {
        record({ kind: 'child-end', id, at: clock(), error: error.message });
        throw error;
      }
    };
  }
  // Attribute synchronous filesystem costs only in Cotal processes, not npm internals.
  // Each group retains first/last wall timestamps and summed API time, not an invented function duration.
  const groups = new Map();
  if (process.argv.some(arg => /(?:cotal\.js|cotal\.ts)$/.test(arg))) {
    for (const name of ['readFileSync', 'readdirSync', 'statSync', 'lstatSync', 'realpathSync', 'cpSync', 'copyFileSync', 'rmSync', 'mkdirSync', 'renameSync', 'writeFileSync', 'chmodSync']) {
      const original = fs[name];
      fs[name] = function (...args) {
        const at = clock();
        const caller = stack();
        try { return Reflect.apply(original, this, args); }
        finally {
          const end = clock();
          const key = `${name}\n${caller}`;
          const group = groups.get(key) ?? { kind: 'filesystem-group', api: name, stack: caller, start: at, end, durationMs: 0, calls: 0 };
          group.end = end;
          group.durationMs += end - at;
          group.calls++;
          groups.set(key, group);
        }
      };
      Object.assign(fs[name], original);
    }
  }
  for (const [name, stream] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
    const original = stream.write;
    stream.write = function (chunk, ...args) {
      record({ kind: 'output', stream: name, at: clock(), text: String(chunk) });
      return Reflect.apply(original, this, [chunk, ...args]);
    };
  }
  syncBuiltinESMExports();
  process.once('exit', status => {
    for (const group of groups.values()) record(group);
    record({ kind: 'process-end', at: clock(), status });
  });
}
