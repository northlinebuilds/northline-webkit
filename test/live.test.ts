import { it } from "vitest";
import { PAID_ROUTES } from "../src/app";

it.skipIf(!process.env.LIVE)("live smoke", async () => {
  for (const r of PAID_ROUTES) {
    const out = await r.run(fetch, r.input).catch((e: Error) => ({ error: e.message }));
    console.log(r.path, JSON.stringify(out).slice(0, 250));
  }
}, 120000);
