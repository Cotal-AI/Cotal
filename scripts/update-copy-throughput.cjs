// Measurement-only observer for original recursive copy operations, with no extra reads in the timed region.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { syncBuiltinESMExports } = require('node:module');
const path = require('node:path');
const list = fs.readdirSync.bind(fs), stat = fs.lstatSync.bind(fs);
const append = fs.appendFileSync.bind(fs);
const output = process.env.COPY_THROUGHPUT_DIR;
if (output) {
  const clock = () => performance.timeOrigin + performance.now();
  const copies = [];
  let active;
  for (const name of ['copyFileSync', 'mkdirSync', 'lstatSync', 'statSync', 'readlinkSync', 'symlinkSync', 'chmodSync', 'utimesSync']) {
    const original = fs[name];
    fs[name] = function (...args) {
      if (!active) return Reflect.apply(original, this, args);
      const start = clock();
      try {
        const result = Reflect.apply(original, this, args);
        if (name === 'statSync' || name === 'lstatSync') {
          if (result?.isFile()) active.bytes.set(String(args[0]), Number(result.size));
          else if (result?.isDirectory()) active.directories.add(String(args[0]));
        }
        if (name === 'copyFileSync') active.files.add(String(args[0]));
        return result;
      } finally {
        const row = active.apis[name] ??= { calls: 0, durationMs: 0 };
        row.calls++; row.durationMs += clock() - start;
      }
    };
    Object.assign(fs[name], original);
  }
  const original = fs.cpSync;
  fs.cpSync = function (...args) {
    const stack = new Error().stack;
    if (active || !stack.includes('addTransaction')) return Reflect.apply(original, this, args);
    const row = { start: clock(), source: String(args[0]), destination: String(args[1]), apis: {}, files: new Set(), directories: new Set(), bytes: new Map() };
    active = row;
    try { return Reflect.apply(original, this, args); }
    finally {
      active = undefined;
      const end = clock();
      // Count only after the original timed call. Some Node builds copy natively and expose no
      // per-file JS calls. Do not force another implementation by changing cpSync's options.
      let files = 0, directories = 0, bytes = 0;
      const walk = directory => {
        for (const entry of list(directory, { withFileTypes: true })) {
          const file = path.join(directory, entry.name);
          if (entry.isDirectory()) { directories++; walk(file); }
          else if (entry.isFile()) { files++; bytes += Number(stat(file).size); }
        }
      };
      walk(args[1]);
      copies.push({ pid: process.pid, start: row.start, end, durationMs: end - row.start, source: row.source, destination: row.destination,
        files, directories, bytes, apis: row.apis, countMethod: 'destination scan after timed original call' });
    }
  };
  syncBuiltinESMExports();
  process.once('exit', () => { for (const row of copies) append(path.join(output, `${process.pid}.jsonl`), JSON.stringify(row) + '\n'); });
}
