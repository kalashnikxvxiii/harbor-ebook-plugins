/* Exercises every method a Harbor eBook plugin must expose and prints
 * what came back, so a source can be checked without installing it. */
export default async function (call) {
  const l = (s) => console.log("  " + s);
  const t = async (label, fn) => {
    const a = Date.now();
    let r;
    try { r = await fn(); } catch (e) { l(`${label.padEnd(22)} FAILED: ${e.message}`); return null; }
    l(`${label.padEnd(22)} ${String(Date.now() - a).padStart(6)} ms  ${Array.isArray(r) ? r.length + " items" : ""}`);
    return r;
  };
  const query = process.env.QUERY || "manzoni";

  const pop = await t("popular(0)", () => call("popular", [0]));
  if (pop?.length) l(`   ${pop.slice(0, 3).map((b) => `${b.title.slice(0, 30)} [${(b.authors || []).join().slice(0, 20)}]`).join("\n   ")}`);

  const res = await t(`search(${query})`, () => call("search", [query, 0]));
  if (res?.length) l(`   ${res.slice(0, 3).map((b) => b.id).join("\n   ")}`);

  const target = res?.[0] || pop?.[0];
  if (!target) return l("nessun risultato: search e popular non hanno prodotto voci");

  const d = await t("detail", () => call("detail", [target.id]));
  if (d) l(`   "${d.title}" | autori:${(d.authors || []).length} | cover:${d.cover ? "sì" : "no"} | descr:${(d.description || "").length}`);

  const ch = await t("chapters", () => call("chapters", [target.id]));
  if (!ch?.length) return l("   nessun capitolo");
  l(`   ${ch.length} capitoli — ${ch.slice(0, 5).map((c) => c.title.slice(0, 20)).join(" · ")}`);

  const c = await t("content (primo)", () => call("content", [ch[0].id]));
  if (c !== null) {
    l(`   ${c.length} caratteri, stacchi di paragrafo: ${(c.match(/\n\n/g) || []).length}`);
    if (!/\n\n/.test(c)) l("   ATTENZIONE: nessun doppio a capo — lo scroll del lettore non funzionera'");
  }
}
