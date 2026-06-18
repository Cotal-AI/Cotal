export function startBearerServer(opts?: { token?: string }): Promise<{
  url: string;
  close: () => Promise<void>;
}>;

export function startOAuthServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}>;
