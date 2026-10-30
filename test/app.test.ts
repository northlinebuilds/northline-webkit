import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createApp, PAID_ROUTES } from "../src/app";
import { fakeFacilitator, PAY_TO, makeWeb, html } from "./mocks";

const env = { PAY_TO, NETWORK: "eip155:8453", FACILITATOR: "payai", PUBLIC_BASE_URL: "https://webkit.example.workers.dev" };
const web = makeWeb({ "https://example.com/": () => html("<html><head><title>Example Domain</title></head><body><h1>Example Domain</h1><p>Hi</p></body></html>") });

async function payHeaders(app: any, path: string) {
  const first = await app.request(path);
  const buyer = new x402Client();
  registerExactEvmScheme(buyer, { signer: privateKeyToAccount(generatePrivateKey()) });
  const http = new x402HTTPClient(buyer);
  const pr = http.getPaymentRequiredResponse((n) => first.headers.get(n), await first.json().catch(() => undefined));
  return { pr, headers: http.encodePaymentSignatureHeader(await buyer.createPaymentPayload(pr)) };
}

describe("free routes", () => {
  it("index, health, openapi (AgentCash shape), llms.txt, well-known", async () => {
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: fakeFacilitator().client });
    const idx: any = await (await app.request("/")).json();
    expect(idx.endpoints).toHaveLength(PAID_ROUTES.length);
    expect(idx.payment.payTo).toBe(PAY_TO);
    expect(await (await app.request("/health")).json()).toMatchObject({ ok: true });
    const oa: any = await (await app.request("/openapi.json")).json();
    expect(oa.info["x-guidance"]).toBeTruthy();
    expect(oa.info.contact.email).toBe("northline@mail.grokbot.com");
    const op = oa.paths["/v1/url/markdown"].get;
    expect(op["x-payment-info"]).toMatchObject({ protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.003000" } });
    expect(op.responses["402"]).toBeTruthy();
    expect(await (await app.request("/llms.txt")).text()).toContain("/v1/domain/report");
    const wk: any = await (await app.request("/.well-known/x402")).json();
    expect(wk.resources).toHaveLength(PAID_ROUTES.length);
    expect(wk.resources[0]).toMatch(/^https:\/\/webkit\.example\.workers\.dev\/v1\//);
    expect((await app.request("/nope")).status).toBe(404);
    expect((await app.request("/v1/nope")).status).toBe(404);
  });
});

describe("x402 paywall", () => {
  it("every paid route answers a bare probe with a 402 + bazaar block, HEAD 402, POST 405", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    for (const r of PAID_ROUTES) {
      const res = await app.request(r.path);
      expect(res.status, r.path).toBe(402);
      const pr = JSON.parse(atob(res.headers.get("payment-required")!));
      expect(pr.accepts[0]).toMatchObject({ scheme: "exact", network: "eip155:8453", payTo: PAY_TO, amount: String(Math.round(Number(r.price.slice(1)) * 1e6)) });
      expect(pr.resource.url).toBe("https://webkit.example.workers.dev" + r.path);
      expect(pr.extensions?.bazaar).toBeTruthy();
      const body: any = await res.json();
      expect(body.x402Version).toBe(2);
      expect(body.accepts[0].payTo).toBe(PAY_TO);
    }
    const head = await app.request("/v1/url/check", { method: "HEAD" });
    expect(head.status).toBe(402);
    expect(head.headers.get("payment-required")).toBeTruthy();
    expect((await app.request("/v1/url/check", { method: "POST" })).status).toBe(405);
    expect(log.verify + log.settle).toBe(0);
    expect(web.calls).toHaveLength(0);
  });

  it("paid requests with bad input get 400 and are never verified or settled", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const pay = { "payment-signature": "e30=" };
    for (const p of ["/v1/url/markdown", "/v1/url/check?url=http://127.0.0.1/", "/v1/dns/lookup?domain=example.com&type=BAD", "/v1/email/check?email=@@", "/v1/domain/whois?domain=localhost", "/v1/url/links?url=https://a.com&external=maybe", "/v1/url/markdown?url=a.com&maxChars=99"])
      expect((await app.request(p, { headers: pay })).status, p).toBe(400);
    expect(log.verify + log.settle).toBe(0);
  });

  it("serves data and settles after a valid x402 payment", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const path = "/v1/url/markdown?url=https://example.com/";
    const { headers } = await payHeaders(app, path);
    const paid = await app.request(path, { headers });
    expect(paid.status).toBe(200);
    const body: any = await paid.json();
    expect(body.title).toBe("Example Domain");
    expect(body.markdown).toContain("# Example Domain");
    expect(log.verify).toBe(1);
    expect(log.settle).toBe(1);
    expect(paid.headers.get("PAYMENT-RESPONSE")).toBeTruthy();
  });

  it("does not settle when the upstream fails (502)", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const path = "/v1/url/metadata?url=https://unreachable.example.org/";
    const { headers } = await payHeaders(app, path);
    const res = await app.request(path, { headers });
    expect(res.status).toBe(502);
    expect(log.settle).toBe(0);
  });

  it("rejects an invalid payment without serving data", async () => {
    const { client, log } = fakeFacilitator({ valid: false });
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const path = "/v1/url/check?url=https://example.com/";
    const { headers } = await payHeaders(app, path);
    expect((await app.request(path, { headers })).status).toBe(402);
    expect(log.settle).toBe(0);
  });

  it("refuses to start without a valid PAY_TO", () => {
    expect(() => createApp({ PAY_TO: "nope" } as any)).toThrow(/PAY_TO/);
  });
});
