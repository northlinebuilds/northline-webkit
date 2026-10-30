import { Hono, type Context } from "hono";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import { bazaarResourceServerExtension, declareDiscoveryExtension } from "@x402/extensions/bazaar";
import * as W from "./web";
import { handleMcp, mcpTools } from "./mcp";

export interface Env {
  PAY_TO: string;
  NETWORK?: string;
  FACILITATOR?: string;
  CDP_API_KEY_ID?: string;
  CDP_API_KEY_SECRET?: string;
  PUBLIC_BASE_URL?: string;
  SERVICE_NAME?: string;
}

export const FACILITATOR_URLS: Record<string, string> = {
  cdp: "https://api.cdp.coinbase.com/platform/v2/x402",
  payai: "https://facilitator.payai.network",
  dexter: "https://x402.dexter.cash",
  testnet: "https://x402.org/facilitator",
};

export const MCP_REGISTRY_AUTH = "v=MCPv1; k=ed25519; p=sZJ8OGFLH5ovRuyD+frnR94rt/ZbgBLUfpZQn5kjEIc=";
export const CONTACT_EMAIL = "northline@mail.grokbot.com";
export const SIBLINGS = [
  { name: "Northline ChainKit", url: "https://northline-chainkit.northline-c86.workers.dev", summary: "Onchain facts on Base and Arc: address risk preflight, USDC payment verification, tx explainer, gas, balances ($0.001-$0.005)." },
  { name: "Northline Unclaimed", url: "https://northline-unclaimed.northline-c86.workers.dev", summary: "Free check for crypto a wallet can still claim; full report via x402." },
];

const urlP = { type: "string", description: "Public http(s) URL (scheme optional)", minLength: 3 };
const domainP = { type: "string", description: "Domain name, e.g. example.com", minLength: 3 };

type Q = Record<string, string | undefined>;
export interface RouteDef {
  key: string;
  path: string;
  tool: string;
  price: string;
  tags: string[];
  description: string;
  input: Record<string, string>;
  inputSchema: { properties: Record<string, unknown>; required?: string[] };
  example: Record<string, unknown>;
  validate: (q: Q) => void;
  run: (f: W.FetchLike, q: Q) => Promise<unknown>;
}

/** Single source of truth for paid routes: price, docs, Bazaar/OpenAPI metadata, validation, handler. */
export const PAID_ROUTES: RouteDef[] = [
  {
    key: "GET /v1/url/markdown",
    path: "/v1/url/markdown",
    tool: "url_to_markdown",
    price: "$0.003",
    tags: ["web", "scrape", "markdown", "reader", "rag"],
    description: "Fetch any public web page and return clean, readable Markdown (main content only: no scripts, nav or footer) plus title, word count and final URL. Ideal for feeding pages to an LLM.",
    input: { url: "https://example.com" },
    inputSchema: { properties: { url: urlP, maxChars: { type: "string", description: "Max markdown characters (1000-50000, default 20000)" } }, required: ["url"] },
    example: { url: "https://example.com/", title: "Example Domain", words: 30, markdown: "# Example Domain\n\nThis domain is for use in documentation examples..." },
    validate: (q) => {
      W.parseUrl(q.url);
      if (q.maxChars !== undefined && !(/^\d{4,5}$/.test(q.maxChars) && Number(q.maxChars) <= 50000)) throw new W.InputError("maxChars must be 1000-50000");
    },
    run: async (f, q) => {
      const page = await W.getHtml(f, W.parseUrl(q.url));
      const max = Math.min(50000, Math.max(1000, Number(q.maxChars ?? 20000)));
      const meta = W.extractMetadata(page.html, page.finalUrl);
      return { url: q.url, finalUrl: page.finalUrl.toString(), status: page.status, title: meta.title, description: meta.description, lang: meta.lang, ...W.htmlToMarkdown(page.html, page.finalUrl, max) };
    },
  },
  {
    key: "GET /v1/url/metadata",
    path: "/v1/url/metadata",
    tool: "url_metadata",
    price: "$0.002",
    tags: ["web", "metadata", "opengraph", "seo", "link-preview"],
    description: "Link preview and SEO metadata for any URL: title, description, canonical, language, Open Graph and Twitter card, favicon, RSS/Atom feeds and JSON-LD types, after following redirects.",
    input: { url: "https://github.com" },
    inputSchema: { properties: { url: urlP }, required: ["url"] },
    example: { finalUrl: "https://github.com/", title: "GitHub", openGraph: { image: "https://github.githubassets.com/..." }, favicon: "https://github.com/favicon.ico" },
    validate: (q) => void W.parseUrl(q.url),
    run: async (f, q) => {
      const page = await W.getHtml(f, W.parseUrl(q.url));
      return { url: q.url, finalUrl: page.finalUrl.toString(), status: page.status, redirects: page.redirects, ...W.extractMetadata(page.html, page.finalUrl) };
    },
  },
  {
    key: "GET /v1/url/links",
    path: "/v1/url/links",
    tool: "url_links",
    price: "$0.002",
    tags: ["web", "links", "crawl", "seo"],
    description: "Every unique outgoing link on a web page (absolute URLs, anchor text, internal vs external), up to 500. Use it to crawl a site or find related pages.",
    input: { url: "https://news.ycombinator.com" },
    inputSchema: { properties: { url: urlP, external: { type: "string", enum: ["only", "exclude"], description: "Filter to only or exclude external links" } }, required: ["url"] },
    example: { count: 120, internal: 90, external: 30, links: [{ url: "https://example.org/", text: "Example", internal: false }] },
    validate: (q) => {
      W.parseUrl(q.url);
      if (q.external !== undefined && !["only", "exclude"].includes(q.external)) throw new W.InputError("external must be 'only' or 'exclude'");
    },
    run: async (f, q) => {
      const page = await W.getHtml(f, W.parseUrl(q.url));
      const r = W.extractLinks(page.html, page.finalUrl);
      const links = q.external === "only" ? r.links.filter((l) => !l.internal) : q.external === "exclude" ? r.links.filter((l) => l.internal) : r.links;
      return { url: q.url, finalUrl: page.finalUrl.toString(), ...r, links };
    },
  },
  {
    key: "GET /v1/url/check",
    path: "/v1/url/check",
    tool: "url_check",
    price: "$0.001",
    tags: ["web", "uptime", "status", "redirects", "security-headers"],
    description: "Is this URL up? HTTP status, full redirect chain, final URL, response time, content type, server/CDN and a security-headers grade (HSTS, CSP, X-Frame-Options...).",
    input: { url: "http://github.com" },
    inputSchema: { properties: { url: urlP }, required: ["url"] },
    example: { status: 200, ok: true, redirects: 1, finalUrl: "https://github.com/", responseMs: 180, securityHeaders: { grade: "A" } },
    validate: (q) => void W.parseUrl(q.url),
    run: (f, q) => W.urlCheck(f, W.parseUrl(q.url)),
  },
  {
    key: "GET /v1/dns/lookup",
    path: "/v1/dns/lookup",
    tool: "dns_lookup",
    price: "$0.001",
    tags: ["dns", "domain", "network"],
    description: "DNS records for a domain over DNS-over-HTTPS: A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, SRV, PTR or HTTPS, with TTLs and DNSSEC validation flag.",
    input: { domain: "example.com", type: "MX" },
    inputSchema: { properties: { domain: domainP, type: { type: "string", enum: [...W.DNS_TYPES], default: "A" } }, required: ["domain"] },
    example: { name: "example.com", type: "MX", status: "NOERROR", answers: [{ type: "MX", ttl: 86400, data: "0 ." }] },
    validate: (q) => {
      W.parseDomain(q.domain);
      W.parseDnsType(q.type);
    },
    run: (f, q) => W.dnsLookup(f, W.parseDomain(q.domain), W.parseDnsType(q.type)),
  },
  {
    key: "GET /v1/email/check",
    path: "/v1/email/check",
    tool: "email_domain_check",
    price: "$0.002",
    tags: ["email", "validation", "mx", "spf", "dmarc", "lead"],
    description: "Check an email address or domain before you send: syntax, MX servers, accepts mail?, disposable or free provider, mail provider (Google, Microsoft...), SPF and DMARC policy, with risk flags.",
    input: { email: "someone@gmail.com" },
    inputSchema: { properties: { email: { type: "string", description: "Email address or bare domain" } }, required: ["email"] },
    example: { domain: "gmail.com", acceptsMail: true, disposable: false, freeProvider: true, mailProvider: "Google Workspace", dmarc: { policy: "none" }, flags: ["free_email_provider"] },
    validate: (q) => void W.parseEmailOrDomain(q.email ?? q.domain),
    run: (f, q) => W.emailDomainCheck(f, W.parseEmailOrDomain(q.email ?? q.domain)),
  },
  {
    key: "GET /v1/domain/whois",
    path: "/v1/domain/whois",
    tool: "domain_whois",
    price: "$0.002",
    tags: ["whois", "rdap", "domain", "registrar", "security"],
    description: "WHOIS for a domain via official RDAP: registered?, registrar, creation/expiry dates, domain age in days, status codes, nameservers, DNSSEC and abuse contact. Spot newly registered (phishing) domains.",
    input: { domain: "example.com" },
    inputSchema: { properties: { domain: domainP }, required: ["domain"] },
    example: { domain: "example.com", registered: true, registrar: "RESERVED-Internet Assigned Numbers Authority", created: "1995-08-14T04:00:00Z", ageDays: 11400 },
    validate: (q) => void W.parseDomain(q.domain),
    run: (f, q) => W.rdapDomain(f, W.parseDomain(q.domain)),
  },
  {
    key: "GET /v1/robots/check",
    path: "/v1/robots/check",
    tool: "robots_check",
    price: "$0.001",
    tags: ["web", "robots", "crawl", "compliance", "ai-crawlers"],
    description: "May I crawl this URL? Parses robots.txt and answers allowed true/false for your user agent and path, the matching rule, sitemaps, and whether 14 AI crawlers (GPTBot, ClaudeBot, PerplexityBot...) are allowed.",
    input: { url: "https://www.nytimes.com/section/technology", userAgent: "GPTBot" },
    inputSchema: { properties: { url: urlP, userAgent: { type: "string", default: "*" } }, required: ["url"] },
    example: { allowed: false, matchedRule: "Disallow: /", sitemaps: ["https://www.nytimes.com/sitemaps/new/news.xml.gz"], aiCrawlers: { GPTBot: false, ClaudeBot: false } },
    validate: (q) => {
      W.parseUrl(q.url);
      if (q.userAgent !== undefined && q.userAgent.length > 200) throw new W.InputError("userAgent too long");
    },
    run: (f, q) => W.robotsCheck(f, W.parseUrl(q.url), q.userAgent || "*"),
  },
  {
    key: "GET /v1/domain/report",
    path: "/v1/domain/report",
    tool: "domain_report",
    price: "$0.005",
    tags: ["domain", "security", "due-diligence", "phishing", "whois", "dns"],
    description: "One-call domain due diligence: RDAP registration (age, registrar, expiry), DNS (A/AAAA/NS/CAA, DNSSEC), email setup (MX/SPF/DMARC), HTTPS reachability with security-headers grade, and risk flags such as newly_registered_lt_30d.",
    input: { domain: "stripe.com" },
    inputSchema: { properties: { domain: domainP }, required: ["domain"] },
    example: { domain: "stripe.com", registration: { ageDays: 10000 }, https: { status: 200, securityHeaders: { grade: "A" } }, flags: [] },
    validate: (q) => void W.parseDomain(q.domain),
    run: (f, q) => W.domainReport(f, W.parseDomain(q.domain)),
  },
];

export interface AppOptions {
  fetch?: W.FetchLike;
  facilitatorClient?: FacilitatorClient;
}

async function buildFacilitator(env: Env): Promise<FacilitatorClient> {
  const choice = (env.FACILITATOR ?? "payai").toLowerCase();
  if (choice === "cdp") {
    if (!env.CDP_API_KEY_ID || !env.CDP_API_KEY_SECRET) throw new Error("FACILITATOR=cdp needs CDP_API_KEY_ID and CDP_API_KEY_SECRET secrets");
    const { createFacilitatorConfig } = await import("@coinbase/x402");
    return new HTTPFacilitatorClient(createFacilitatorConfig(env.CDP_API_KEY_ID, env.CDP_API_KEY_SECRET));
  }
  const url = FACILITATOR_URLS[choice] ?? choice;
  if (!/^https:\/\//.test(url)) throw new Error(`bad FACILITATOR '${env.FACILITATOR}'`);
  return new HTTPFacilitatorClient({ url });
}

const svc = (env: Env) => env.SERVICE_NAME ?? "Northline WebKit";

export function routesConfig(env: Env) {
  const network = (env.NETWORK ?? "eip155:8453") as `${string}:${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(env.PAY_TO ?? "")) throw new Error("PAY_TO must be set to a 0x address");
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return Object.fromEntries(
    PAID_ROUTES.map((r) => [
      r.key,
      {
        accepts: { scheme: "exact", price: r.price, network, payTo: env.PAY_TO, maxTimeoutSeconds: 120 },
        description: r.description,
        mimeType: "application/json",
        serviceName: svc(env),
        tags: [...r.tags],
        ...(base ? { resource: base + r.path } : {}),
        unpaidResponseBody: () => ({
          contentType: "application/json",
          body: {
            error: "payment_required",
            price: r.price + " USDC on Base (x402 exact)",
            how: "Retry with an x402 client (x402-fetch, x402-axios, AgentCash, CDP AgentKit); it reads the PAYMENT-REQUIRED header and pays automatically. Bad input is rejected before payment and failed calls are never settled.",
            exampleQuery: r.input,
            docs: (base ?? "") + "/openapi.json",
          },
        }),
        extensions: { ...declareDiscoveryExtension({ input: r.input, inputSchema: { type: "object", ...r.inputSchema }, output: { example: r.example } }) },
      },
    ]),
  );
}

function errorResponse(c: Context, e: unknown) {
  if (e instanceof W.InputError) return c.json({ error: e.message }, 400);
  if (e instanceof W.UpstreamError) return c.json({ error: e.message }, 502);
  return c.json({ error: "internal_error" }, 500);
}

export function openapi(env: Env) {
  const base = env.PUBLIC_BASE_URL?.replace(/\/$/, "");
  return {
    openapi: "3.1.0",
    info: {
      title: svc(env),
      version: "1.0.0",
      description: "Pay-per-call web and domain utilities for AI agents: URL to Markdown, link preview metadata, links, uptime/redirect check, DNS, email-domain check, WHOIS/RDAP, robots.txt and a one-call domain report. x402 (USDC on Base), no API key, no signup.",
      "x-guidance":
        "All endpoints are GET with query parameters and return JSON. Pay per call with x402 (USDC on Base); an unpaid call returns HTTP 402 with the price. Use /v1/url/markdown to read a web page as Markdown, /v1/url/metadata for title/description/Open Graph, /v1/url/links to list links, /v1/url/check for status/redirects/uptime, /v1/robots/check before crawling, /v1/dns/lookup for DNS records, /v1/email/check before emailing an address, /v1/domain/whois for registrar/age/expiry, /v1/domain/report for full domain due diligence (phishing/new-domain check). Bad input returns 400 before payment; failed upstream calls are not charged.",
      contact: { name: "Northline", email: CONTACT_EMAIL, ...(base ? { url: base + "/llms.txt" } : {}) },
    },
    servers: base ? [{ url: base }] : [],
    paths: Object.fromEntries(
      PAID_ROUTES.map((r) => [
        r.path,
        {
          get: {
            operationId: r.tool,
            summary: r.description.split(/[:.?]/)[0].slice(0, 100),
            description: r.description,
            tags: r.tags,
            "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: Number(r.price.replace("$", "")).toFixed(6) }, network: env.NETWORK ?? "eip155:8453", asset: "USDC" },
            parameters: Object.entries(r.inputSchema.properties).map(([name, schema]) => ({ name, in: "query", required: (r.inputSchema.required ?? []).includes(name), schema, ...(r.input[name] ? { example: r.input[name] } : {}) })),
            responses: {
              "200": { description: "OK", content: { "application/json": { schema: { type: "object" }, example: r.example } } },
              "400": { description: "Bad input (rejected before payment; never charged)" },
              "402": { description: "Payment Required (x402 v2 PAYMENT-REQUIRED header; same JSON in body)" },
              "502": { description: "Target or upstream unreachable (payment not settled)" },
            },
          },
        },
      ]),
    ),
  };
}

export function createApp(env: Env, opts: AppOptions = {}) {
  const app = new Hono();
  const f: W.FetchLike = opts.fetch ?? ((i, init) => fetch(i, init));
  const routes = routesConfig(env);
  const base = (env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "");

  let mw: ReturnType<typeof paymentMiddleware> | null = null;
  const getMw = async () => {
    if (!mw) {
      const fac = opts.facilitatorClient ?? (await buildFacilitator(env));
      const server = new x402ResourceServer(fac).register((env.NETWORK ?? "eip155:8453") as `${string}:${string}`, new ExactEvmScheme());
      server.registerExtension(bazaarResourceServerExtension);
      mw = paymentMiddleware(routes as never, server);
    }
    return mw;
  };

  const index = () => ({
    service: svc(env),
    summary: "Pay-per-call web and domain utilities for AI agents. x402, USDC on Base, $0.001-$0.005 per call, no API key, no signup.",
    payment: { protocol: "x402 v2", scheme: "exact", network: env.NETWORK ?? "eip155:8453", asset: "USDC", payTo: env.PAY_TO },
    endpoints: PAID_ROUTES.map((r) => ({ method: "GET", path: r.path, price: r.price, description: r.description, example: { query: r.input } })),
    free: ["/", "/health", "/openapi.json", "/llms.txt", "/.well-known/x402", "/mcp"],
    mcp: { url: base + "/mcp", transport: "streamable-http", tools: mcpTools().map((t) => t.name), payment: "x402 MCP transport; webkit_catalog is free" },
    contact: CONTACT_EMAIL,
    related: SIBLINGS,
  });
  app.get("/", (c) => c.json(index()));
  app.get("/health", (c) => c.json({ ok: true, service: svc(env), routes: PAID_ROUTES.length }));
  app.all("/mcp", (c) => handleMcp(c.req.raw, base || new URL(c.req.url).origin, (r) => Promise.resolve(app.fetch(r, c.env)), svc(env)));
  app.get("/.well-known/mcp-registry-auth", (c) => c.text(MCP_REGISTRY_AUTH));
  const wellKnown = () => ({
    version: 1,
    resources: PAID_ROUTES.map((r) => base + r.path),
    instructions: "GET with query params; unpaid requests return HTTP 402 with an x402 v2 PAYMENT-REQUIRED header. See /openapi.json.",
  });
  app.get("/.well-known/x402", (c) => c.json(wellKnown()));
  app.get("/.well-known/x402.json", (c) => c.json(wellKnown()));
  app.get("/openapi.json", (c) => c.json(openapi(env)));
  app.get("/llms.txt", (c) =>
    c.text(
      [
        `# ${svc(env)}`,
        "> Pay-per-call web and domain utilities for AI agents, paid with x402 (USDC on Base, $0.001-$0.005). No signup, no API key.",
        "",
        ...PAID_ROUTES.map((r) => `- GET ${r.path} (${r.price}): ${r.description} Example: ${r.path}?${new URLSearchParams(r.input).toString()}`),
        "",
        "Unpaid requests get HTTP 402 with a PAYMENT-REQUIRED header (and the same PaymentRequired JSON in the body); any x402 client (x402-fetch, x402-axios, AgentCash, CDP AgentKit) pays automatically. Bad input returns 400 before payment; failed calls are never settled.",
        "",
        "## MCP",
        `- Remote MCP server (Streamable HTTP): ${base}/mcp . Tools: ${mcpTools().map((t) => t.name).join(", ")}. webkit_catalog is free; the others are paid per call with the x402 MCP transport (params._meta["x402/payment"]), e.g. with @x402/mcp.`,
        "",
        "## When to use",
        "- Read a web page for an LLM: url_to_markdown. Link preview / SEO: url_metadata. Crawl: url_links + robots_check.",
        "- Is a site up, where does a link redirect: url_check.",
        "- Before emailing someone: email_domain_check. Is a domain new or suspicious: domain_whois or domain_report.",
        "",
        "## Related (Northline)",
        ...SIBLINGS.map((s) => `- ${s.name} (${s.url}): ${s.summary}`),
        "",
        `Contact: ${CONTACT_EMAIL}`,
      ].join("\n"),
    ),
  );

  // Payment gate: unpaid -> 402 always (crawlers probe with placeholder input); paid -> validate first.
  app.use("/v1/*", async (c, next) => {
    const method = c.req.method;
    if (method === "HEAD") {
      const res = await app.fetch(new Request(c.req.url, { method: "GET", headers: { accept: "application/json" } }));
      return new Response(null, { status: res.status === 200 ? 402 : res.status, headers: res.headers });
    }
    if (method !== "GET") return c.json({ error: "method_not_allowed", allow: "GET" }, 405, { allow: "GET" });
    const route = PAID_ROUTES.find((r) => r.path === c.req.path);
    if (!route) return c.json({ error: "not_found", see: "/" }, 404);
    const hasPayment = !!(c.req.header("payment-signature") || c.req.header("x-payment"));
    if (!hasPayment) {
      const r = await (await getMw())(c, next);
      const res = (r as Response | undefined) ?? c.res;
      const h = res?.headers.get("payment-required");
      if (res && res.status === 402 && h) {
        try {
          const pr = JSON.parse(atob(h));
          const hints = (await res.clone().json().catch(() => ({}))) as Record<string, unknown>;
          const headers = new Headers(res.headers);
          headers.delete("content-length");
          headers.set("content-type", "application/json");
          return new Response(JSON.stringify({ ...pr, ...hints, x402Version: pr.x402Version, accepts: pr.accepts }), { status: 402, headers });
        } catch {}
      }
      return r;
    }
    try {
      route.validate(c.req.query());
    } catch (e) {
      return errorResponse(c, e);
    }
    return (await getMw())(c, next);
  });

  for (const r of PAID_ROUTES)
    app.get(r.path, async (c) => {
      try {
        return c.json((await r.run(f, c.req.query())) as object);
      } catch (e) {
        return errorResponse(c, e);
      }
    });
  app.notFound((c) => c.json({ error: "not_found", see: "/" }, 404));
  return app;
}
