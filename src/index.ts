import { createApp, type Env } from "./app";

let cached: { key: string; app: ReturnType<typeof createApp> } | null = null;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const key = `${env.PAY_TO}|${env.NETWORK}|${env.FACILITATOR}|${env.PUBLIC_BASE_URL}`;
    if (!cached || cached.key !== key) cached = { key, app: createApp(env) };
    return cached.app.fetch(request, env, ctx);
  },
};
