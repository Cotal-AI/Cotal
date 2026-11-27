/** Auth and provider-routing env `claude` actually reads for a headless or container seat.
 *  Drawn from Anthropic's authentication precedence
 *  (https://docs.anthropic.com/en/docs/claude-code/iam) and the env-vars page, not from a
 *  prefix guess. `CLAUDE_CODE_OAUTH_TOKEN` is the load-bearing name: `docs/deploy.mdx` and
 *  `deploy/` tell operators a container Claude authenticates with it, and a container has no
 *  Keychain. Host-session markers (`CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`,
 *  `CLAUDE_CODE_ENTRYPOINT`) are deliberately absent — those are how a nested `claude` decides
 *  it must not save a transcript. Files under the default `~/.claude` and `~/.aws` locations
 *  remain reachable through HOME. A credential file at a non-default path is reachable only when
 *  its path variable, such as `GOOGLE_APPLICATION_CREDENTIALS`, is forwarded explicitly. */
export const CLAUDE_PROVIDER_KEYS = [
  // First-party / subscription (setup-token, Console key, gateway bearer).
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_SCOPES",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
  // Cloud provider selection. Without the matching flag, the credential vars below are inert.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_AWS_CRED_CACHE",
  "CLAUDE_CODE_AWS_CHAIN_RESOLVE_TIMEOUT_MS",
  // Amazon Bedrock / Claude Platform on AWS.
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_CONFIG_FILE",
  "AWS_BEARER_TOKEN_BEDROCK",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_BEDROCK_REGION_PREFIX",
  "ANTHROPIC_BEDROCK_SERVICE_TIER",
  "ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION",
  // Google Cloud's Agent Platform.
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CLOUD_ML_REGION",
  "GCLOUD_PROJECT",
  "GOOGLE_CLOUD_PROJECT",
  "VERTEX_REGION_CLAUDE_3_5_HAIKU",
  "VERTEX_REGION_CLAUDE_3_5_SONNET",
  "VERTEX_REGION_CLAUDE_3_7_SONNET",
  "VERTEX_REGION_CLAUDE_4_0_OPUS",
  "VERTEX_REGION_CLAUDE_4_0_SONNET",
  "VERTEX_REGION_CLAUDE_4_1_OPUS",
  "VERTEX_REGION_CLAUDE_4_5_OPUS",
  "VERTEX_REGION_CLAUDE_4_5_SONNET",
  "VERTEX_REGION_CLAUDE_4_6_OPUS",
  "VERTEX_REGION_CLAUDE_4_6_SONNET",
  "VERTEX_REGION_CLAUDE_4_7_OPUS",
  "VERTEX_REGION_CLAUDE_4_8_OPUS",
  "VERTEX_REGION_CLAUDE_5_OPUS",
  "VERTEX_REGION_CLAUDE_5_SONNET",
  "VERTEX_REGION_CLAUDE_FABLE_5",
  "VERTEX_REGION_CLAUDE_FABLE_5_1",
  "VERTEX_REGION_CLAUDE_HAIKU_4_5",
  // Microsoft Foundry.
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  // Workload Identity Federation / named Anthropic profiles.
  "ANTHROPIC_PROFILE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
] as const;
