/** Preserve Codex login/config roots without exposing mesh credentials to model-run commands. */
export function codexChildEnv(
  source: NodeJS.ProcessEnv,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...source };
  delete env.OPENAI_API_KEY;
  for (const key of Object.keys(env))
    if (key.startsWith("COTAL_")) delete env[key];
  return env;
}
