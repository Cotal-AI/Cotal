const { appendFileSync } = require('node:fs');

const file = process.env.RESPONSIVE_TRACE;
if (file) {
  const entry = process.argv[1] ?? '';
  const script = process.argv.slice(1).find(arg => /[\\/]smoke[\\/][\w-]+\.smoke\.ts$/.test(arg));
  const flags = process.argv.filter(arg => ['--retry', '--pending'].includes(arg));
  const record = (event, details = {}) => appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), event, pid: process.pid, ppid: process.ppid, ...details }) + '\n');
  if (script || /(?:tsx|pnpm)[\\/]|[\\/]pnpm\.(?:c?js|exe)$/i.test(entry)) {
    record('node-start', { entry, script, flags });
    const write = process.stdout.write;
    process.stdout.write = function (chunk, ...args) {
      const skip = String(chunk).includes('COTAL_SMOKE_SENTINEL skipped=');
      if (skip) record('skip-write-start');
      const result = write.call(this, chunk, ...args);
      if (skip) record('skip-write-return', { accepted: result });
      return result;
    };
    const exit = process.exit;
    process.exit = function (code) {
      record('process-exit-call', { code });
      return exit.call(this, code);
    };
    process.on('beforeExit', code => record('before-exit', { code }));
    process.on('exit', code => record('exit-event', { code }));
  }
}
