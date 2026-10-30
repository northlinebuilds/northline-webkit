import { describe, it, expect } from "vitest";
import * as W from "../src/web";
import { makeWeb, html, json, doh } from "./mocks";

const PAGE = `<!doctype html><html lang="en"><head><title>Hello &amp; Welcome</title>
<meta name="description" content="A test page">
<meta property="og:title" content="OG Hello"><meta property="og:image" content="/img.png">
<link rel="canonical" href="https://example.com/hello"><link rel="icon" href="/fav.png">
<link rel="alternate" type="application/rss+xml" href="/feed.xml">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article"}</script>
<script>var x = 1;</script><style>.a{}</style></head>
<body><nav><a href="/nav">Nav</a></nav><main><h1>Big Title</h1><p>Some <b>bold</b> text and a <a href="/docs">doc link</a>.</p>
<ul><li>One</li><li>Two</li></ul><pre>code()</pre><a href="https://other.org/x#frag">Other</a><a href="javascript:void(0)">js</a></main><footer>foot</footer></body></html>`;

describe("input validation", () => {
  it("accepts public URLs and adds https", () => {
    expect(W.parseUrl("example.com/a").toString()).toBe("https://example.com/a");
  });
  it("blocks private, local, credentialed and odd-port URLs", () => {
    for (const u of ["http://localhost/", "http://127.0.0.1/", "http://10.0.0.1", "http://192.168.1.1", "http://169.254.169.254/latest", "http://[::1]/", "ftp://x.com", "http://u:p@x.com", "http://x.com:22/", "http://intranet/"]) expect(() => W.parseUrl(u), u).toThrow(W.InputError);
    expect(() => W.parseUrl(undefined)).toThrow(/missing/);
  });
  it("parses domains and emails", () => {
    expect(W.parseDomain("https://Example.COM/path")).toBe("example.com");
    expect(() => W.parseDomain("not a domain")).toThrow(W.InputError);
    expect(W.parseEmailOrDomain("a@b.co")).toEqual({ email: "a@b.co", domain: "b.co" });
    expect(() => W.parseDnsType("XYZ")).toThrow(W.InputError);
    expect(W.registrableDomain("www.bbc.co.uk")).toBe("bbc.co.uk");
    expect(W.registrableDomain("a.b.example.com")).toBe("example.com");
  });
});

describe("html extraction", () => {
  const base = new URL("https://example.com/hello");
  it("metadata", () => {
    const m = W.extractMetadata(PAGE, base);
    expect(m.title).toBe("Hello & Welcome");
    expect(m.description).toBe("A test page");
    expect(m.openGraph.image).toBe("https://example.com/img.png");
    expect(m.favicon).toBe("https://example.com/fav.png");
    expect(m.feeds[0].url).toBe("https://example.com/feed.xml");
    expect(m.jsonLdTypes).toEqual(["Article"]);
    expect(m.lang).toBe("en");
  });
  it("links", () => {
    const l = W.extractLinks(PAGE, base);
    expect(l.links.map((x) => x.url)).toEqual(["https://example.com/nav", "https://example.com/docs", "https://other.org/x"]);
    expect(l.external).toBe(1);
  });
  it("markdown keeps main content only", () => {
    const md = W.htmlToMarkdown(PAGE, base).markdown;
    expect(md).toContain("# Big Title");
    expect(md).toContain("**bold**");
    expect(md).toContain("[doc link](https://example.com/docs)");
    expect(md).toContain("- One");
    expect(md).toContain("```\ncode()\n```");
    expect(md).not.toContain("var x");
    expect(md).not.toContain("foot");
    expect(md).not.toContain("Nav");
    expect(W.htmlToMarkdown(PAGE, base, 10).truncated).toBe(true);
  });
});

describe("network helpers", () => {
  it("follows redirects and re-checks each hop against private hosts", async () => {
    const web = makeWeb({
      "http://a.com/": () => new Response(null, { status: 301, headers: { location: "https://a.com/" } }),
      "https://a.com/": () => html("<title>A</title>", 200, { "strict-transport-security": "max-age=1", "x-content-type-options": "nosniff", "cf-ray": "1" }),
      "https://evil.com/": () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } }),
    });
    const r = await W.urlCheck(web.fetch, new URL("http://a.com/"));
    expect(r).toMatchObject({ status: 200, redirects: 1, finalUrl: "https://a.com/", https: true, cdn: "Cloudflare" });
    expect(r.securityHeaders.present).toContain("strict-transport-security");
    await expect(W.urlCheck(web.fetch, new URL("https://evil.com/"))).rejects.toThrow(/private/);
    expect(web.calls).not.toContain("http://127.0.0.1/admin");
  });
  it("email check reads MX/SPF/DMARC", async () => {
    const web = makeWeb({
      "https://cloudflare-dns.com/dns-query?name=gmail.com&type=MX": () => doh([{ name: "gmail.com.", type: 15, data: "5 gmail-smtp-in.l.google.com." }]),
      "https://cloudflare-dns.com/dns-query?name=gmail.com&type=TXT": () => doh([{ name: "gmail.com.", type: 16, data: '"v=spf1 redirect=_spf.google.com"' }]),
      "https://cloudflare-dns.com/dns-query?name=_dmarc.gmail.com&type=TXT": () => doh([{ name: "_dmarc.gmail.com.", type: 16, data: '"v=DMARC1; p=none; sp=quarantine"' }]),
      "https://cloudflare-dns.com/dns-query?name=gmail.com&type=A": () => doh([{ name: "gmail.com.", type: 1, data: "1.2.3.4" }]),
    });
    const r = await W.emailDomainCheck(web.fetch, W.parseEmailOrDomain("x@gmail.com"));
    expect(r).toMatchObject({ acceptsMail: true, freeProvider: true, disposable: false, mailProvider: "Google Workspace", syntaxValid: true });
    expect(r.spf).toContain("v=spf1");
    expect(r.dmarc?.policy).toBe("none");
    expect(r.flags).toContain("dmarc_monitor_only");
  });
  it("rdap via IANA bootstrap", async () => {
    const created = new Date(Date.now() - 5 * 86400000).toISOString();
    const web = makeWeb({
      "https://data.iana.org/rdap/dns.json": () => json({ services: [[["com", "net"], ["https://rdap.verisign.com/com/v1/"]]] }),
      "https://rdap.verisign.com/com/v1/domain/new-thing.com": () => json({ handle: "1", events: [{ eventAction: "registration", eventDate: created }, { eventAction: "expiration", eventDate: "2030-01-01T00:00:00Z" }], status: ["active"], nameservers: [{ ldhName: "NS1.X.COM" }], entities: [{ roles: ["registrar"], vcardArray: ["vcard", [["fn", {}, "text", "Some Registrar"]]], publicIds: [{ type: "IANA Registrar ID", identifier: "123" }] }] }),
      "https://rdap.verisign.com/com/v1/domain/free-one.com": () => new Response("", { status: 404 }),
    });
    const r: any = await W.rdapDomain(web.fetch, "www.new-thing.com");
    expect(r).toMatchObject({ domain: "new-thing.com", registered: true, registrar: "Some Registrar", registrarIanaId: "123", ageDays: 5, nameservers: ["ns1.x.com"] });
    expect((await W.rdapDomain(web.fetch, "free-one.com")).registered).toBe(false);
  });
  it("robots.txt verdicts", () => {
    const p = W.parseRobots("User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: GPTBot\nDisallow: /\nSitemap: https://x.com/s.xml");
    expect(W.robotsVerdict(p, "*", "/private/a").allowed).toBe(false);
    expect(W.robotsVerdict(p, "*", "/private/ok/1").allowed).toBe(true);
    expect(W.robotsVerdict(p, "Mozilla", "/public").allowed).toBe(true);
    expect(W.robotsVerdict(p, "GPTBot", "/public").allowed).toBe(false);
    expect(p.sitemaps).toEqual(["https://x.com/s.xml"]);
  });
});
