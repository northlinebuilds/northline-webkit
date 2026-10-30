import type { FacilitatorClient } from "@x402/core/server";

export const PAY_TO = "0xFe5D81D8268CBaC025829CEdD11D5cF6962d4096";
const word = (hex: string) => "0x" + hex.replace(/^0x/, "").padStart(64, "0");
export const abiString = (s: string) => {
  const b = Buffer.from(s, "utf8").toString("hex");
  return "0x" + word("20").slice(2) + word(b.length / 2 === 0 ? "0" : (b.length / 2).toString(16)).slice(2) + b.padEnd(Math.ceil(b.length / 64) * 64 || 64, "0");
};
export { word };

type Handler = (method: string, params: any[]) => unknown;

/** Fake JSON-RPC + Sourcify fetch. Records every request so tests can assert no network surprises. */
export function makeFetch(handler: Handler, sourcify: Record<string, string | null> = {}) {
  const calls: { url: string; body?: any }[] = [];
  const f = async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.includes("sourcify")) {
      const addr = url.split("/").pop()!.toLowerCase();
      return new Response(JSON.stringify({ match: sourcify[addr] ?? null }), { status: 200 });
    }
    const arr = Array.isArray(body) ? body : [body];
    const out = arr.map((c: any) => {
      try {
        const r = handler(c.method, c.params);
        return r === undefined ? { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "revert" } } : { jsonrpc: "2.0", id: c.id, result: r };
      } catch {
        return { jsonrpc: "2.0", id: c.id, error: { code: -32000, message: "revert" } };
      }
    });
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch: f, calls };
}

export function fakeFacilitator(opts: { valid?: boolean } = {}) {
  const log = { verify: 0, settle: 0, lastPayload: null as any };
  const client: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:8453" }], extensions: ["bazaar"], signers: {} } as any;
    },
    async verify(payload: any) {
      log.verify++;
      log.lastPayload = payload;
      return opts.valid === false ? ({ isValid: false, invalidReason: "invalid_signature" } as any) : ({ isValid: true, payer: "0x1111111111111111111111111111111111111111" } as any);
    },
    async settle() {
      log.settle++;
      return { success: true, transaction: "0x" + "cd".repeat(32), network: "eip155:8453", payer: "0x1111111111111111111111111111111111111111" } as any;
    },
  };
  return { client, log };
}

/** Fake web: map of exact URL (or prefix ending in *) -> handler. Unknown URLs throw like a network error. */
export function makeWeb(routes: Record<string, (url: string, init?: RequestInit) => Response>) {
  const calls: string[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    const h = routes[url] ?? Object.entries(routes).find(([k]) => k.endsWith("*") && url.startsWith(k.slice(0, -1)))?.[1];
    if (!h) throw new Error("ENOTFOUND " + url);
    return h(url, init);
  };
  return { fetch: f, calls };
}
export const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
export const doh = (answers: { name: string; type: number; TTL?: number; data: string }[], Status = 0) => json({ Status, AD: true, Answer: answers.map((a) => ({ TTL: 300, ...a })) });
