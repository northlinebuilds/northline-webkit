# Northline WebKit

Pay-per-call web tools for AI agents. **x402 + USDC on Base**, works over plain HTTP or as an **MCP server**. No API keys, no signup, no subscription: each call costs $0.001–$0.005, paid inline.

- **Live API:** https://northline-webkit.northline-c86.workers.dev
- **MCP endpoint (Streamable HTTP):** `https://northline-webkit.northline-c86.workers.dev/mcp`
- **OpenAPI:** [/openapi.json](https://northline-webkit.northline-c86.workers.dev/openapi.json) · **LLM docs:** [/llms.txt](https://northline-webkit.northline-c86.workers.dev/llms.txt) · **x402 discovery:** [/.well-known/x402](https://northline-webkit.northline-c86.workers.dev/.well-known/x402)
- **MCP Registry:** `dev.workers.northline-c86.northline-webkit/webkit`

## Routes and prices

All routes are `GET` with query parameters (`*` = required). Prices are per successful call, in USDC on Base.

| Route | MCP tool | Price | Params | What you get |
|---|---|---|---|---|
| `/v1/url/markdown` | `url_to_markdown` | $0.003 | `url*`, `maxChars` | Any public page as clean Markdown (main content only) |
| `/v1/url/metadata` | `url_metadata` | $0.002 | `url*` | Title, description, canonical, language, Open Graph / Twitter card, favicon, feeds, JSON-LD types |
| `/v1/url/links` | `url_links` | $0.002 | `url*`, `external` | Every unique outgoing link (absolute URL, anchor text, internal vs external) |
| `/v1/url/check` | `url_check` | $0.001 | `url*` | Up/down, status, redirect chain, response time, server/CDN, security-headers grade |
| `/v1/dns/lookup` | `dns_lookup` | $0.001 | `domain*`, `type` | DNS records over DNS-over-HTTPS (A, AAAA, CNAME, MX, TXT, NS, SOA, CAA, SRV…) |
| `/v1/email/check` | `email_domain_check` | $0.002 | `email*` | Syntax, MX, accepts mail?, disposable or free provider, mail provider, SPF/DMARC, risk flags |
| `/v1/domain/whois` | `domain_whois` | $0.002 | `domain*` | WHOIS via official RDAP: registrar, created/expiry dates, status, nameservers |
| `/v1/robots/check` | `robots_check` | $0.001 | `url*`, `userAgent` | robots.txt verdict for your user agent and path, plus 14 AI crawlers (GPTBot, ClaudeBot…) |
| `/v1/domain/report` | `domain_report` | $0.005 | `domain*` | One-call due diligence: RDAP, DNS/DNSSEC, MX/SPF/DMARC, HTTPS + headers grade, risk flags |

The MCP server also exposes a free `webkit_catalog` tool listing every tool, price and example input.

## How to pay (x402)

1. Call a route without payment → you get **HTTP 402** with the payment requirements (`accepts`: scheme `exact`, network `eip155:8453`, asset USDC, amount, payTo) in the body and `PAYMENT-REQUIRED` header.
2. Sign the payment with any x402 client (EIP-3009 USDC authorization — gasless for you; the facilitator submits it).
3. Retry the same request with the signed payload in the `PAYMENT-SIGNATURE` header → **200** with the result, settlement receipt in `PAYMENT-RESPONSE`.

Input is validated **before** settlement and nothing settles on an error response, so you never pay for a bad request or an upstream failure.

```ts
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const url = "https://northline-webkit.northline-c86.workers.dev/v1/url/check?url=https://example.com";
const client = new x402Client();
registerExactEvmScheme(client, { signer: privateKeyToAccount(process.env.BUYER_KEY as `0x${string}`), networks: ["eip155:8453"] });
const http = new x402HTTPClient(client);

const first = await fetch(url); // 402
const required = http.getPaymentRequiredResponse((h) => first.headers.get(h), await first.json());
const payload = await client.createPaymentPayload(required);
const paid = await fetch(url, { headers: http.encodePaymentSignatureHeader(payload) });
console.log(await paid.json());
```

Any x402-aware agent wallet or client (e.g. AgentCash) works the same way.

### Over MCP

Add the server to any MCP client that supports Streamable HTTP:

```json
{ "mcpServers": { "northline-webkit": { "url": "https://northline-webkit.northline-c86.workers.dev/mcp" } } }
```

Paid tools follow the x402 MCP transport: an unpaid `tools/call` returns `isError` with the payment requirements in `structuredContent`; resend the call with the signed payload in `params._meta["x402/payment"]` and the receipt comes back in `result._meta["x402/payment-response"]`.

## Self-host

```bash
npm ci
npm test                # unit tests (mocked network)
npx wrangler deploy     # Cloudflare Workers free plan
```

Set `PAY_TO` in `wrangler.toml` to your own wallet. Facilitator defaults to PayAI (no key needed).

## Related

- [Northline ChainKit](https://northline-chainkit.northline-c86.workers.dev) — pay-per-call onchain tools (address profile, USDC payment verify, tx explain).

## License

MIT
