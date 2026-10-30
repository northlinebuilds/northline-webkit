/**
 * Remote MCP endpoint (Streamable HTTP, stateless, JSON responses) for Northline WebKit.
 * Paid tools follow the x402 MCP transport (specs/transports-v2/mcp.md): an unpaid call returns
 * isError + PaymentRequired; the client retries with params._meta["x402/payment"]; the settlement
 * receipt comes back in result._meta["x402/payment-response"]. Payment verification/settlement is
 * delegated to the existing HTTP paywall by replaying the call against /v1/* in-process, so the
 * MCP and HTTP paths share one price list, one facilitator and one validation layer.
 */
import { PAID_ROUTES } from "./app";

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const TOOL_NAMES: Record<string, string> = new Proxy({} as Record<string, string>, { get: (_t, k) => PAID_ROUTES.find((r) => r.path === k)?.tool });

export function mcpTools() {
  const paid = PAID_ROUTES.map((r) => ({
    name: TOOL_NAMES[r.path],
    title: r.path,
    description: `${r.description} Costs ${r.price} USDC on Base per call via x402 (unpaid calls return the x402 PaymentRequired; any x402 MCP client pays automatically).`,
    inputSchema: { type: "object", ...r.inputSchema },
    annotations: { readOnlyHint: true, openWorldHint: true },
    _meta: { "x402/price": r.price, "x402/network": "eip155:8453", "x402/asset": "USDC" },
  }));
  const catalog = {
    name: "webkit_catalog",
    title: "WebKit catalog (free)",
    description: "Free. Lists every WebKit tool with its price, required inputs and an example, plus how x402 payment works. Call this first.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  };
  return [catalog, ...paid];
}

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: any };
type Replay = (req: Request) => Promise<Response>;

const b64json = (s: string | null) => {
  if (!s) return undefined;
  try {
    return JSON.parse(atob(s));
  } catch {
    return undefined;
  }
};
const b64enc = (o: unknown) => btoa(JSON.stringify(o));

function paymentError(pr: any) {
  return { isError: true, structuredContent: pr, content: [{ type: "text", text: JSON.stringify(pr) }] };
}

export async function handleMcp(req: Request, baseUrl: string, replay: Replay, serviceName: string): Promise<Response> {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-expose-headers": "mcp-session-id" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" } });
  if (req.method === "GET") {
    // No server-initiated stream; describe the endpoint for humans/crawlers.
    return Response.json(
      { mcp: "streamable-http", endpoint: baseUrl + "/mcp", transport: "POST JSON-RPC 2.0", tools: mcpTools().map((t) => t.name), payment: "x402 MCP transport (USDC on Base)" },
      { status: 200, headers: cors },
    );
  }
  if (req.method === "DELETE") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: cors });

  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: cors });
  }
  const batch = Array.isArray(body) ? body : [body];
  const out: unknown[] = [];
  for (const m of batch) {
    const r = await dispatch(m, baseUrl, replay, serviceName);
    if (r !== null) out.push(r);
  }
  if (out.length === 0) return new Response(null, { status: 202, headers: cors });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: cors });
}

async function dispatch(m: Rpc, baseUrl: string, replay: Replay, serviceName: string) {
  const id = m.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (!m || typeof m.method !== "string") return err(-32600, "Invalid Request");
  if (m.id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return ok({
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "northline-webkit", title: serviceName, version: "1.0.0" },
        instructions:
          "Web and domain utilities: URL to Markdown, link metadata, links, URL status/redirects, DNS, email-domain check, WHOIS/RDAP, robots.txt, domain report. Paid tools cost $0.001-$0.005 USDC on Base via x402; call webkit_catalog (free) for prices.",
      });
    }
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: mcpTools() });
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    case "tools/call":
      return ok(await callTool(m.params ?? {}, baseUrl, replay));
    default:
      return err(-32601, `Method not found: ${m.method}`);
  }
}

async function callTool(params: any, baseUrl: string, replay: Replay) {
  const name = params.name;
  if (name === "webkit_catalog") {
    const catalog = {
      service: "Northline WebKit",
      payment: { protocol: "x402 v2 (MCP transport)", network: "eip155:8453 (Base)", asset: "USDC", how: "Call a paid tool; it returns PaymentRequired. Retry with params._meta['x402/payment'] (x402 MCP clients such as @x402/mcp do this automatically)." },
      tools: PAID_ROUTES.map((r) => ({ tool: TOOL_NAMES[r.path], price: r.price, required: r.inputSchema.required ?? [], example: r.input, description: r.description })),
      http: baseUrl + "/openapi.json",
    };
    return { content: [{ type: "text", text: JSON.stringify(catalog) }], structuredContent: catalog };
  }
  const route = PAID_ROUTES.find((r) => TOOL_NAMES[r.path] === name);
  if (!route) return { isError: true, content: [{ type: "text", text: `Unknown tool '${name}'. Call webkit_catalog.` }] };
  const args = (params.arguments ?? {}) as Record<string, unknown>;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const url = baseUrl + route.path + (qs.size ? "?" + qs.toString() : "");
  const payment = params._meta?.["x402/payment"];
  const headers: Record<string, string> = { accept: "application/json" };
  if (payment) headers["payment-signature"] = b64enc(payment);
  const res = await replay(new Request(url, { method: "GET", headers }));
  if (res.status === 402) {
    const pr = b64json(res.headers.get("payment-required")) ?? { x402Version: 2, error: "Payment required", accepts: [] };
    if (payment && !pr.error) pr.error = "Payment rejected";
    return paymentError(pr);
  }
  const text = await res.text();
  if (res.status !== 200) return { isError: true, content: [{ type: "text", text: `HTTP ${res.status}: ${text} (no payment was settled)` }] };
  let data: unknown = undefined;
  try {
    data = JSON.parse(text);
  } catch {}
  const settle = b64json(res.headers.get("payment-response") ?? res.headers.get("x-payment-response"));
  return {
    content: [{ type: "text", text }],
    ...(data && typeof data === "object" && !Array.isArray(data) ? { structuredContent: data } : {}),
    ...(settle ? { _meta: { "x402/payment-response": settle } } : {}),
  };
}
