import { spawn } from 'node:child_process';

/** The environment the product sees: the user's own, without test-harness variables or tokens. */
export function productEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('COTAL_') || ['NODE_OPTIONS', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN_FILE'].includes(name)) delete env[name];
  return { ...env, DO_NOT_TRACK: '1', ...extra };
}

/** Runs a program to completion. Never throws on a non-zero exit; callers check `code`. */
export function run(file, args = [], { timeout = 120_000, input, env = productEnv(), cwd } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(file, args, { env, cwd, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, error: error.message, stdout, stderr, ms: Date.now() - started }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut: signal === 'SIGKILL', stdout, stderr, ms: Date.now() - started });
    });
    if (input !== undefined) {
      // A program may exit without reading all of its input; that is its answer, not a runner failure.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

/** Runs a program and throws with its output when it fails. */
export async function must(file, args, options) {
  const result = await run(file, args, options);
  if (result.code !== 0) throw new Error(`${file} ${args.join(' ')} exited ${result.code ?? result.error}: ${tail(result.stderr || result.stdout)}`);
  return result;
}

export function shell(script, options) {
  return process.platform === 'win32'
    ? run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], options)
    : run('/bin/sh', ['-c', script], options);
}

export async function mustShell(script, options) {
  const result = await shell(script, options);
  if (result.code !== 0) throw new Error(`shell step exited ${result.code ?? result.error}: ${tail(result.stderr || result.stdout)}`);
  return result;
}

export function tail(text, max = 1500) {
  const value = String(text ?? '').trim();
  return value.length > max ? `...${value.slice(-max)}` : value;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(probe, { timeout, interval = 1000 }) {
  const until = Date.now() + timeout;
  let last;
  do {
    last = await probe();
    if (last?.ok) return last;
    await sleep(interval);
  } while (Date.now() < until);
  return last ?? { ok: false };
}
