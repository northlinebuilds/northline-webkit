import { describe, it, expect } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { createApp, PAID_ROUTES } from "../src/app";
import { fakeFacilitator, PAY_TO, makeWeb, html } from "./mocks";

const env = { PAY_TO, NETWORK: "eip155:8453", FACILITATOR: "payai", PUBLIC_BASE_URL: "https://webkit.example.workers.dev" };
const web = makeWeb({ "https://example.com/": () => html("<title>Ex</title><p>hi</p>") });
const call = async (app: any, body: unknown) => (await app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify(body) })).json();

describe("MCP", () => {
  it("initialize, tools/list and free catalog", async () => {
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: fakeFacilitator().client });
    const init: any = await call(app, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(init.result.serverInfo.name).toBe("northline-webkit");
    const list: any = await call(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(list.result.tools).toHaveLength(PAID_ROUTES.length + 1);
    expect(list.result.tools.map((t: any) => t.name)).toContain("url_to_markdown");
    const cat: any = await call(app, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "webkit_catalog" } });
    expect(cat.result.structuredContent.tools).toHaveLength(PAID_ROUTES.length);
  });

  it("paid tool: unpaid -> PaymentRequired, paid -> data + receipt", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const first: any = await call(app, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "url_metadata", arguments: { url: "https://example.com/" } } });
    expect(first.result.isError).toBe(true);
    const pr = first.result.structuredContent;
    expect(pr.x402Version).toBe(2);
    const buyer = new x402Client();
    registerExactEvmScheme(buyer, { signer: privateKeyToAccount(generatePrivateKey()) });
    const payload = await buyer.createPaymentPayload(pr);
    const paid: any = await call(app, { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "url_metadata", arguments: { url: "https://example.com/" }, _meta: { "x402/payment": payload } } });
    expect(paid.result.isError).toBeUndefined();
    expect(paid.result.structuredContent.title).toBe("Ex");
    expect(paid.result._meta["x402/payment-response"]).toBeTruthy();
    expect(log.settle).toBe(1);
  });

  it("paid tool with bad input never settles", async () => {
    const { client, log } = fakeFacilitator();
    const app = createApp(env, { fetch: web.fetch, facilitatorClient: client });
    const r: any = await call(app, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "url_check", arguments: { url: "http://localhost/" }, _meta: { "x402/payment": { x402Version: 2 } } } });
    expect(r.result.isError).toBe(true);
    expect(r.result.content[0].text).toContain("400");
    expect(log.verify + log.settle).toBe(0);
  });
});
