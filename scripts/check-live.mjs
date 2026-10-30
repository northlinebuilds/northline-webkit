// Unpaid probe of a deployed WebKit: every paid route must answer 402 with a valid x402 v2 challenge + Bazaar block.
// Free and read-only. Usage: node scripts/check-live.mjs https://northline-chainkit.<sub>.workers.dev
const base = (process.argv[2] || "").replace(/\/$/, "");
if (!/^https?:\/\//.test(base)) { console.error("usage: node scripts/check-live.mjs <baseUrl>"); process.exit(2); }
const idx = await (await fetch(base + "/")).json();
let ok = true;
for (const e of idx.endpoints) {
  const res = await fetch(base + e.path + "?" + new URLSearchParams(e.example.query));
  const hdr = res.headers.get("payment-required");
  let pr = null;
  try { pr = JSON.parse(Buffer.from(hdr, "base64").toString()); } catch {}
  const a = pr?.accepts?.[0];
  const good = res.status === 402 && a?.scheme === "exact" && a?.network === "eip155:8453" && !!pr?.extensions?.bazaar && String(pr?.resource?.url || "").startsWith(base);
  ok &&= good;
  console.log(`${good ? "OK " : "BAD"} ${e.path} status=${res.status} amount=${a?.amount} payTo=${a?.payTo} bazaar=${!!pr?.extensions?.bazaar} resource=${pr?.resource?.url}`);
}
for (const p of ["/openapi.json", "/.well-known/x402", "/llms.txt"]) {
  const r = await fetch(base + p); ok &&= r.ok; console.log(`${r.ok ? "OK " : "BAD"} ${p} ${r.status}`);
}
// x402scan's own validator (read-only check, registers nothing)
try {
  const r = await fetch("https://www.x402scan.com/api/trpc/public.resources.checkDiscovery", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ json: { origin: base } }) });
  console.log("x402scan checkDiscovery:", r.status, (await r.text()).slice(0, 300));
} catch (e) { console.log("x402scan checkDiscovery unreachable:", e.message); }
process.exit(ok ? 0 : 1);
