import { delimiter } from 'node:path';

export function prependPath(env, prefix) {
  const keys = Object.keys(env).filter(key => key.toLowerCase() === 'path');
  if (keys.length !== 1 || typeof env[keys[0]] !== 'string') throw new Error('expected one inherited PATH entry');
  const inherited = env[keys[0]];
  for (const key of keys) delete env[key];
  env.PATH = [prefix, inherited].join(delimiter);
}
