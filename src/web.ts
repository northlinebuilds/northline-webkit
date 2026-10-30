// Web / domain utilities on free, keyless upstreams only:
// the target site itself, Cloudflare DNS-over-HTTPS (cloudflare-dns.com) and RDAP (IANA bootstrap + registry RDAP servers).
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class InputError extends Error {
  status = 400;
}
export class UpstreamError extends Error {
  status = 502;
}

const UA = "NorthlineWebKit/1.0 (+https://northline-webkit.northline-c86.workers.dev)";
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 9000;

// ---------- input validation (runs before payment so buyers never pay for a 400)
const HOST_RE = /^(?=.{1,253}$)(?!-)([a-z0-9-]{1,63}(?<!-)\.)+[a-z]{2,63}$/i;

function isPrivateHost(h: string): boolean {
  const host = h.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true;
  const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (host.includes(":")) return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80") || host === "::";
  return false;
}

export function parseUrl(raw: string | undefined): URL {
  if (!raw) throw new InputError("missing query parameter 'url'");
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new InputError(`invalid url '${raw}'`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new InputError("url must be http(s)");
  if (u.username || u.password) throw new InputError("url must not contain credentials");
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) throw new InputError("url port not allowed");
  if (isPrivateHost(u.hostname)) throw new InputError("private or local hosts are not allowed");
  if (!u.hostname.includes(".")) throw new InputError("url host must be a public domain");
  return u;
}

export function parseDomain(raw: string | undefined, name = "domain"): string {
  if (!raw) throw new InputError(`missing query parameter '${name}'`);
  let d = raw.trim().toLowerCase();
  if (d.includes("@")) d = d.split("@").pop()!;
  d = d.replace(/^https?:\/\//, "").split(/[/?#]/)[0].replace(/\.$/, "");
  if (!HOST_RE.test(d) || isPrivateHost(d)) throw new InputError(`invalid ${name} '${raw}'`);
  return d;
}

export function parseEmailOrDomain(raw: string | undefined): { email?: string; domain: string } {
  if (!raw) throw new InputError("missing query parameter 'email' (or 'domain')");
  const s = raw.trim();
  if (s.includes("@")) {
    if (!/^[^\s@]{1,64}@[^\s@]+$/.test(s)) throw new InputError(`invalid email '${raw}'`);
    return { email: s, domain: parseDomain(s.split("@").pop(), "email") };
  }
  return { domain: parseDomain(s, "email") };
}

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "CAA", "SRV", "PTR", "HTTPS"] as const;
export function parseDnsType(raw: string | undefined): string {
  const t = (raw ?? "A").toUpperCase();
  if (!(DNS_TYPES as readonly string[]).includes(t)) throw new InputError(`unsupported type '${raw}'. Use one of ${DNS_TYPES.join(", ")}`);
  return t;
}

// ---------- fetching
async function timedFetch(f: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await f(url, { ...init, signal: ctl.signal });
  } catch (e) {
    throw new UpstreamError(`could not reach ${new URL(url).hostname}: ${(e as Error).name === "AbortError" ? "timeout" : (e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

async function readCapped(res: Response, max = MAX_BYTES): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.byteLength;
    if (n >= max) {
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const buf = new Uint8Array(Math.min(n, max));
  let o = 0;
  for (const c of chunks) {
    const take = Math.min(c.byteLength, buf.length - o);
    buf.set(c.subarray(0, take), o);
    o += take;
    if (o >= buf.length) break;
  }
  return { text: new TextDecoder("utf-8").decode(buf), truncated };
}

export interface Hop {
  url: string;
  status: number;
  location?: string;
}

/** Follow redirects manually (max 8) so every hop is re-checked against the private-host rule. */
export async function fetchPage(f: FetchLike, start: URL, accept = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5", method = "GET") {
  const hops: Hop[] = [];
  let url = start;
  const t0 = Date.now();
  for (let i = 0; i < 9; i++) {
    const res = await timedFetch(f, url.toString(), { method, redirect: "manual", headers: { "user-agent": UA, accept } });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      hops.push({ url: url.toString(), status: res.status, location: loc });
      await res.body?.cancel().catch(() => {});
      if (i === 8) throw new UpstreamError("too many redirects");
      url = parseUrl(new URL(loc, url).toString());
      continue;
    }
    hops.push({ url: url.toString(), status: res.status });
    return { res, finalUrl: url, hops, ms: Date.now() - t0 };
  }
  throw new UpstreamError("too many redirects");
}

// ---------- HTML helpers (regex based: tiny CPU budget, no DOM in Workers)
const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", mdash: "—", ndash: "–", hellip: "…", copy: "©", reg: "®", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const clean = (s: string | undefined | null) => (s == null ? undefined : decodeEntities(s.replace(/\s+/g, " ").trim()) || undefined);

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? "";
  return out;
}

export function extractMetadata(html: string, base: URL) {
  const head = html.slice(0, 300_000);
  const meta: Record<string, string> = {};
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const k = (a.property ?? a.name ?? a.itemprop ?? "").toLowerCase();
    if (k && a.content !== undefined && !(k in meta)) meta[k] = a.content;
  }
  const links: { rel: string; href: string; type?: string; sizes?: string }[] = [];
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.rel && a.href) links.push({ rel: a.rel.toLowerCase(), href: a.href, type: a.type, sizes: a.sizes });
  }
  const abs = (h?: string) => {
    if (!h) return undefined;
    try {
      return new URL(decodeEntities(h), base).toString();
    } catch {
      return undefined;
    }
  };
  const rel = (r: string) => links.find((l) => l.rel.split(/\s+/).includes(r));
  const title = clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const lang = head.match(/<html\b[^>]*\blang\s*=\s*["']?([a-zA-Z-]+)/i)?.[1];
  const feeds = links.filter((l) => l.rel.includes("alternate") && /rss|atom|feed\+json/.test(l.type ?? "")).map((l) => ({ type: l.type, url: abs(l.href) }));
  const jsonLdTypes: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1]);
      const walk = (x: any) => {
        if (Array.isArray(x)) x.forEach(walk);
        else if (x && typeof x === "object") {
          if (x["@type"]) jsonLdTypes.push(...[].concat(x["@type"]));
          if (x["@graph"]) walk(x["@graph"]);
        }
      };
      walk(j);
    } catch {}
  }
  return {
    title,
    description: clean(meta["description"] ?? meta["og:description"] ?? meta["twitter:description"]),
    canonical: abs(rel("canonical")?.href),
    lang,
    siteName: clean(meta["og:site_name"] ?? meta["application-name"]),
    author: clean(meta["author"] ?? meta["article:author"]),
    publishedTime: meta["article:published_time"] ?? meta["date"] ?? meta["dc.date"],
    keywords: clean(meta["keywords"]),
    robots: meta["robots"],
    themeColor: meta["theme-color"],
    favicon: abs(rel("icon")?.href ?? rel("shortcut")?.href) ?? new URL("/favicon.ico", base).toString(),
    appleTouchIcon: abs(rel("apple-touch-icon")?.href),
    openGraph: {
      title: clean(meta["og:title"]),
      description: clean(meta["og:description"]),
      image: abs(meta["og:image"] ?? meta["og:image:url"]),
      type: meta["og:type"],
      url: abs(meta["og:url"]),
    },
    twitter: { card: meta["twitter:card"], site: meta["twitter:site"], title: clean(meta["twitter:title"]), image: abs(meta["twitter:image"]) },
    feeds,
    jsonLdTypes: [...new Set(jsonLdTypes)].slice(0, 20),
  };
}

export function extractLinks(html: string, base: URL, limit = 500) {
  const seen = new Map<string, { url: string; text?: string; rel?: string; internal: boolean }>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]);
    if (!a.href) continue;
    const href = decodeEntities(a.href.trim());
    if (/^(javascript|mailto|tel|data):/i.test(href) || href.startsWith("#")) continue;
    let u: URL;
    try {
      u = new URL(href, base);
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    u.hash = "";
    const key = u.toString();
    if (seen.has(key)) continue;
    const text = clean(m[2].replace(/<[^>]+>/g, " "));
    seen.set(key, { url: key, text: text?.slice(0, 200), rel: a.rel, internal: u.hostname === base.hostname });
    if (seen.size >= limit) break;
  }
  const all = [...seen.values()];
  return { count: all.length, internal: all.filter((l) => l.internal).length, external: all.filter((l) => !l.internal).length, links: all };
}

/** Readable markdown from HTML: drops scripts/styles/nav/header/footer/forms, keeps headings, lists, links, code, tables as text. */
export function htmlToMarkdown(html: string, base: URL, maxChars = 20000) {
  let h = html;
  const main = h.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
  const body = h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i);
  h = main ? main[2] : body ? body[1] : h;
  h = h
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|iframe|template|form|button|select|canvas)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<(nav|footer|aside)\b[\s\S]*?<\/\1>/gi, "");
  if (!main) h = h.replace(/<header\b[\s\S]*?<\/header>/gi, "");
  h = h
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, c) => "\n\n```\n" + decodeEntities(c.replace(/<[^>]+>/g, "")).trim() + "\n```\n\n")
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, c) => "\n\n" + "#".repeat(Number(n)) + " " + c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() + "\n\n")
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_, at, c) => {
      const t = c.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const href = attrs(at).href;
      if (!t) return "";
      try {
        return href && !/^(javascript|#)/i.test(href) ? `[${t}](${new URL(decodeEntities(href), base).toString()})` : t;
      } catch {
        return t;
      }
    })
    .replace(/<img\b([^>]*)>/gi, (_, at) => {
      const a = attrs(at);
      return a.alt ? ` ![${a.alt}] ` : "";
    })
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol|table|tr|blockquote|h[1-6])>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  let md = decodeEntities(h)
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = md.length > maxChars;
  if (truncated) md = md.slice(0, maxChars);
  const words = md ? md.split(/\s+/).length : 0;
  return { markdown: md, chars: md.length, words, truncated };
}

// ---------- DNS over HTTPS (Cloudflare 1.1.1.1 JSON API, free, keyless)
const DOH = "https://cloudflare-dns.com/dns-query";
const RCODE: Record<number, string> = { 0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 5: "REFUSED" };
const TYPE_NUM: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 65: "HTTPS", 257: "CAA" };

export async function dnsQuery(f: FetchLike, name: string, type: string) {
  const res = await timedFetch(f, `${DOH}?name=${encodeURIComponent(name)}&type=${type}`, { headers: { accept: "application/dns-json" } });
  if (!res.ok) throw new UpstreamError(`DNS resolver returned HTTP ${res.status}`);
  const j: any = await res.json();
  return {
    name,
    type,
    status: RCODE[j.Status] ?? String(j.Status),
    dnssecValidated: !!j.AD,
    answers: (j.Answer ?? []).map((a: any) => ({ name: String(a.name).replace(/\.$/, ""), type: TYPE_NUM[a.type] ?? String(a.type), ttl: a.TTL, data: String(a.data).replace(/^"|"$/g, "").replace(/" "/g, "") })),
  };
}

export async function dnsLookup(f: FetchLike, domain: string, type: string) {
  return { ...(await dnsQuery(f, domain, type)), resolver: "cloudflare-dns.com (DoH)" };
}

// ---------- email domain check
const DISPOSABLE = new Set(
  "10minutemail.com 20minutemail.com guerrillamail.com guerrillamail.net sharklasers.com mailinator.com mailinator.net yopmail.com yopmail.net tempmail.com temp-mail.org tempmail.net throwawaymail.com trashmail.com getnada.com nada.email maildrop.cc dispostable.com fakeinbox.com mintemail.com mohmal.com emailondeck.com tempail.com tempr.email discard.email spamgourmet.com mailnesia.com mytemp.email burnermail.io 33mail.com inboxkitten.com mail.tm mail.gw moakt.com tmail.ws tmpmail.org emailfake.com fakemail.net"
    .split(" "),
);
const FREE_PROVIDERS = new Set("gmail.com googlemail.com yahoo.com ymail.com outlook.com hotmail.com live.com msn.com icloud.com me.com mac.com aol.com proton.me protonmail.com pm.me gmx.com gmx.de mail.com zoho.com yandex.com yandex.ru fastmail.com tutanota.com tuta.io hey.com qq.com 163.com 126.com naver.com".split(" "));
const MX_PROVIDERS: [RegExp, string][] = [
  [/google\.com$|googlemail\.com$/, "Google Workspace"],
  [/outlook\.com$|protection\.outlook\.com$/, "Microsoft 365"],
  [/pphosted\.com$/, "Proofpoint"],
  [/mimecast\.com$/, "Mimecast"],
  [/zoho\.(com|eu|in)$/, "Zoho"],
  [/protonmail\.ch$/, "Proton"],
  [/messagingengine\.com$/, "Fastmail"],
  [/yahoodns\.net$/, "Yahoo"],
  [/icloud\.com$/, "iCloud"],
  [/mailgun\.org$/, "Mailgun"],
  [/amazonaws\.com$/, "Amazon SES"],
  [/secureserver\.net$/, "GoDaddy"],
];

export async function emailDomainCheck(f: FetchLike, input: { email?: string; domain: string }) {
  const d = input.domain;
  const [mx, txt, dmarc, a] = await Promise.all([dnsQuery(f, d, "MX"), dnsQuery(f, d, "TXT"), dnsQuery(f, `_dmarc.${d}`, "TXT"), dnsQuery(f, d, "A")]);
  const mxHosts = mx.answers
    .filter((x: any) => x.type === "MX")
    .map((x: any) => {
      const [pref, host] = String(x.data).split(/\s+/);
      return { preference: Number(pref), host: (host ?? "").replace(/\.$/, "") };
    })
    .sort((x: any, y: any) => x.preference - y.preference);
  const nullMx = mxHosts.length === 1 && (mxHosts[0].host === "" || mxHosts[0].host === ".");
  const spf = txt.answers.map((x: any) => x.data).find((t: string) => /^v=spf1\b/i.test(t));
  const dm = dmarc.answers.map((x: any) => x.data).find((t: string) => /^v=DMARC1\b/i.test(t));
  const dmarcPolicy = dm?.match(/\bp=([a-z]+)/i)?.[1]?.toLowerCase();
  const provider = mxHosts.map((m: any) => MX_PROVIDERS.find(([re]) => re.test(m.host))?.[1]).find(Boolean);
  const acceptsMail = mx.status === "NOERROR" && !nullMx && (mxHosts.length > 0 || a.answers.some((x: any) => x.type === "A"));
  const flags: string[] = [];
  if (mx.status === "NXDOMAIN") flags.push("domain_does_not_exist");
  if (!acceptsMail) flags.push("no_mail_server");
  if (nullMx) flags.push("null_mx");
  if (DISPOSABLE.has(d)) flags.push("disposable_domain");
  if (FREE_PROVIDERS.has(d)) flags.push("free_email_provider");
  if (!spf) flags.push("no_spf");
  if (!dm) flags.push("no_dmarc");
  else if (dmarcPolicy === "none") flags.push("dmarc_monitor_only");
  const syntaxValid = input.email ? /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(input.email) && !input.email.split("@")[0].startsWith(".") && !input.email.includes("..") : undefined;
  if (syntaxValid === false) flags.push("invalid_syntax");
  return {
    email: input.email,
    domain: d,
    syntaxValid,
    acceptsMail,
    disposable: DISPOSABLE.has(d),
    freeProvider: FREE_PROVIDERS.has(d),
    mailProvider: provider ?? (mxHosts.length ? "other" : undefined),
    mx: mxHosts,
    spf: spf ?? null,
    dmarc: dm ? { record: dm, policy: dmarcPolicy } : null,
    flags,
    note: "DNS-level check only (no SMTP probe, so no mailbox-exists guarantee).",
  };
}

// ---------- RDAP (WHOIS replacement)
let bootstrap: { at: number; map: Map<string, string> } | null = null;
async function rdapServer(f: FetchLike, tld: string): Promise<string | undefined> {
  if (!bootstrap || Date.now() - bootstrap.at > 86_400_000) {
    const res = await timedFetch(f, "https://data.iana.org/rdap/dns.json");
    if (!res.ok) throw new UpstreamError(`IANA RDAP bootstrap HTTP ${res.status}`);
    const j: any = await res.json();
    const map = new Map<string, string>();
    for (const [tlds, urls] of j.services ?? []) for (const t of tlds) map.set(String(t).toLowerCase(), (urls.find((u: string) => u.startsWith("https")) ?? urls[0]).replace(/\/?$/, "/"));
    bootstrap = { at: Date.now(), map };
  }
  return bootstrap.map.get(tld);
}

export function registrableDomain(d: string): string {
  // Heuristic eTLD+1 (handles common 2-level public suffixes); RDAP for subdomains is answered for the parent.
  const parts = d.split(".");
  const two = parts.slice(-2).join(".");
  const sld2 = /^(co|com|net|org|gov|edu|ac|or|ne|go|gob|nic|ltd|plc|me)\.[a-z]{2}$/;
  if (parts.length >= 3 && sld2.test(two)) return parts.slice(-3).join(".");
  return two;
}

export async function rdapDomain(f: FetchLike, domainIn: string) {
  const domain = registrableDomain(domainIn);
  const tld = domain.split(".").pop()!;
  const server = await rdapServer(f, tld);
  if (!server) return { domain, registered: null, error: `no RDAP server published for .${tld} (IANA bootstrap)`, source: "https://data.iana.org/rdap/dns.json" };
  const url = `${server}domain/${domain}`;
  const res = await timedFetch(f, url, { headers: { accept: "application/rdap+json, application/json" } });
  if (res.status === 404) return { domain, registered: false, source: url };
  if (!res.ok) throw new UpstreamError(`RDAP server returned HTTP ${res.status}`);
  const j: any = await res.json();
  const ev = (a: string) => (j.events ?? []).find((e: any) => e.eventAction === a)?.eventDate;
  const vcardName = (ent: any) => ent?.vcardArray?.[1]?.find((x: any) => x[0] === "fn")?.[3] || undefined;
  const registrarEnt = (j.entities ?? []).find((e: any) => (e.roles ?? []).includes("registrar"));
  const abuse = (registrarEnt?.entities ?? []).find((e: any) => (e.roles ?? []).includes("abuse"));
  const abuseEmail = abuse?.vcardArray?.[1]?.find((x: any) => x[0] === "email")?.[3];
  const created = ev("registration");
  const expires = ev("expiration");
  const now = Date.now();
  return {
    domain,
    registered: true,
    handle: j.handle,
    registrar: vcardName(registrarEnt) ?? null,
    registrarIanaId: registrarEnt?.publicIds?.find((p: any) => /IANA/i.test(p.type))?.identifier ?? null,
    abuseContact: abuseEmail ?? null,
    created: created ?? null,
    updated: ev("last changed") ?? null,
    expires: expires ?? null,
    ageDays: created ? Math.floor((now - Date.parse(created)) / 86_400_000) : null,
    daysToExpiry: expires ? Math.floor((Date.parse(expires) - now) / 86_400_000) : null,
    status: j.status ?? [],
    nameservers: (j.nameservers ?? []).map((n: any) => String(n.ldhName ?? "").toLowerCase()).filter(Boolean),
    dnssec: j.secureDNS?.delegationSigned ?? null,
    source: url,
  };
}

// ---------- robots.txt
export function parseRobots(txt: string) {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = line.match(/^([a-zA-Z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase();
    const v = m[2].trim();
    if (k === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (k === "sitemap") sitemaps.push(v);
    else if ((k === "allow" || k === "disallow") && cur) {
      if (k === "disallow" && v === "") continue;
      cur.rules.push({ allow: k === "allow", path: v });
    }
  }
  return { groups, sitemaps };
}

function ruleMatch(pattern: string, path: string): boolean {
  const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  return re.test(path);
}

export function robotsVerdict(parsed: ReturnType<typeof parseRobots>, userAgent: string, path: string) {
  const ua = userAgent.toLowerCase();
  const specific = parsed.groups.filter((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const groups = specific.length ? specific : parsed.groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; path: string } | null = null;
  for (const g of groups)
    for (const r of g.rules)
      if (ruleMatch(r.path, path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  return { allowed: best ? best.allow : true, matchedRule: best ? `${best.allow ? "Allow" : "Disallow"}: ${best.path}` : null, matchedGroup: specific.length ? "specific" : groups.length ? "*" : "none" };
}

export const AI_CRAWLERS = ["GPTBot", "ChatGPT-User", "OAI-SearchBot", "ClaudeBot", "Claude-User", "anthropic-ai", "Google-Extended", "PerplexityBot", "CCBot", "Bytespider", "Applebot-Extended", "meta-externalagent", "Amazonbot", "cohere-ai"];

export async function robotsCheck(f: FetchLike, target: URL, userAgent: string) {
  const robotsUrl = new URL("/robots.txt", target.origin);
  const { res } = await fetchPage(f, robotsUrl, "text/plain,*/*;q=0.5");
  const path = target.pathname + target.search;
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    return { robotsUrl: robotsUrl.toString(), found: false, httpStatus: res.status, path, userAgent, allowed: res.status < 500, note: res.status < 500 ? "no robots.txt: everything allowed" : "robots.txt server error: crawlers should treat as disallowed", sitemaps: [], aiCrawlers: {} };
  }
  const { text } = await readCapped(res, 500_000);
  const parsed = parseRobots(text);
  const v = robotsVerdict(parsed, userAgent, path);
  const aiCrawlers = Object.fromEntries(AI_CRAWLERS.map((b) => [b, robotsVerdict(parsed, b, path).allowed]));
  return { robotsUrl: robotsUrl.toString(), found: true, httpStatus: res.status, path, userAgent, ...v, sitemaps: parsed.sitemaps, aiCrawlers, groups: parsed.groups.length };
}

// ---------- URL check (status, redirects, headers, security grade)
const SEC_HEADERS = ["strict-transport-security", "content-security-policy", "x-frame-options", "x-content-type-options", "referrer-policy", "permissions-policy"];
export async function urlCheck(f: FetchLike, u: URL) {
  const { res, finalUrl, hops, ms } = await fetchPage(f, u);
  await res.body?.cancel().catch(() => {});
  const h = (k: string) => res.headers.get(k) ?? undefined;
  const present = SEC_HEADERS.filter((k) => res.headers.has(k));
  const score = present.length + (finalUrl.protocol === "https:" ? 1 : 0);
  const grade = score >= 7 ? "A" : score >= 5 ? "B" : score >= 3 ? "C" : score >= 2 ? "D" : "F";
  return {
    url: u.toString(),
    finalUrl: finalUrl.toString(),
    status: res.status,
    ok: res.status >= 200 && res.status < 300,
    redirects: hops.length - 1,
    hops,
    https: finalUrl.protocol === "https:",
    responseMs: ms,
    contentType: h("content-type"),
    contentLength: h("content-length") ? Number(h("content-length")) : undefined,
    server: h("server"),
    poweredBy: h("x-powered-by"),
    cdn: res.headers.has("cf-ray") ? "Cloudflare" : h("x-vercel-id") ? "Vercel" : h("x-amz-cf-id") ? "CloudFront" : h("x-served-by")?.includes("cache") ? "Fastly" : h("x-nf-request-id") ? "Netlify" : undefined,
    lastModified: h("last-modified"),
    cacheControl: h("cache-control"),
    securityHeaders: { grade, present, missing: SEC_HEADERS.filter((k) => !present.includes(k)) },
  };
}

export async function getHtml(f: FetchLike, u: URL) {
  const { res, finalUrl, hops, ms } = await fetchPage(f, u);
  const ct = res.headers.get("content-type") ?? "";
  if (res.status >= 400) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`target returned HTTP ${res.status}`);
  }
  if (ct && !/html|xml|text\/plain/i.test(ct)) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamError(`target is not HTML (content-type ${ct})`);
  }
  const { text, truncated } = await readCapped(res);
  return { html: text, finalUrl, status: res.status, redirects: hops.length - 1, ms, contentType: ct, bytesTruncated: truncated };
}

// ---------- domain report (bundle)
export async function domainReport(f: FetchLike, domain: string) {
  const [rdap, email, a, aaaa, ns, caa, site] = await Promise.all([
    rdapDomain(f, domain).catch((e) => ({ error: (e as Error).message })),
    emailDomainCheck(f, { domain }).catch((e) => ({ error: (e as Error).message })),
    dnsQuery(f, domain, "A").catch(() => null),
    dnsQuery(f, domain, "AAAA").catch(() => null),
    dnsQuery(f, domain, "NS").catch(() => null),
    dnsQuery(f, domain, "CAA").catch(() => null),
    urlCheck(f, new URL(`https://${domain}/`)).catch((e) => ({ error: (e as Error).message })),
  ]);
  const vals = (q: any, t: string) => (q?.answers ?? []).filter((x: any) => x.type === t).map((x: any) => x.data);
  const flags: string[] = [];
  const r: any = rdap;
  if (r.ageDays != null && r.ageDays < 30) flags.push("newly_registered_lt_30d");
  if (r.daysToExpiry != null && r.daysToExpiry < 30) flags.push("expires_within_30d");
  if (r.registered === false) flags.push("not_registered");
  if ((site as any).error) flags.push("https_unreachable");
  else if ((site as any).securityHeaders?.grade === "F") flags.push("weak_security_headers");
  for (const fl of (email as any).flags ?? []) if (["no_spf", "no_dmarc", "disposable_domain", "no_mail_server"].includes(fl)) flags.push(fl);
  return {
    domain,
    dns: { a: vals(a, "A"), aaaa: vals(aaaa, "AAAA"), ns: vals(ns, "NS").map((x: string) => x.replace(/\.$/, "")), caa: vals(caa, "CAA"), dnssecValidated: !!a?.dnssecValidated },
    registration: rdap,
    email,
    https: site,
    flags,
  };
}
