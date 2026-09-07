/* Harbor eBook plugin — Wikisource
 *
 * Reads Wikisource texts through the official MediaWiki API: no CSS
 * scraping that breaks on a redesign, and the exact same logic works for
 * every language edition. To produce another edition, change the four
 * constants below.
 *
 * Harbor sandbox constraints this code works around:
 *   - no fetch/XHR is available: harbor.http is the only way out
 *   - the CSS engine has no :not() / :nth-child(), so the metadata block
 *     is dropped by comparing text rather than with a selector
 *   - harbor.log() is discarded by the host: debugging must go through
 *     values returned from a method
 */

var LANG = "it";
var SOURCE_ID = "wikisource-it";
var SOURCE_NAME = "Wikisource (italiano)";
var BROWSE_CATEGORY = "Categoria:Letteratura";

var SITE = "https://" + LANG + ".wikisource.org";
var API = SITE + "/w/api.php";
var UA = "HarborWikisourcePlugin/1.0 (personal reader; +https://github.com/kalashnikxvxiii/harbor-ebook-plugins)";
var PAGE_SIZE = 24;

/* --- state kept in memory for as long as the worker lives ----------- */
var popularCache = null;
var browseBuffer = [];
var browseCont = null;
var browseMode = "category";
var browseDone = false;
var searchCursors = {};

/* --- helpers -------------------------------------------------------- */

function qs(params) {
  var out = [];
  for (var k in params) {
    if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
    var v = params[k];
    if (v === undefined || v === null || v === "") continue;
    out.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
  }
  out.push("format=json", "formatversion=2", "origin=*");
  return out.join("&");
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

/* Wikimedia throttles callers that hammer the API and answers 429. Two
 * defences: a minimum gap between calls, and a couple of retries with
 * growing backoff that honour Retry-After. */
var lastCallAt = 0;
var MIN_GAP_MS = 250;

async function api(params, attempt) {
  attempt = attempt || 0;
  var gap = lastCallAt + MIN_GAP_MS - Date.now();
  if (gap > 0) await sleep(gap);
  lastCallAt = Date.now();

  var res;
  try {
    res = await harbor.http(API + "?" + qs(params), {
      responseType: "text",
      headers: { "User-Agent": UA, Accept: "application/json" },
      timeoutMs: 20000
    });
  } catch (e) {
    return {};
  }
  if (!res) return {};
  if (res.status === 429 && attempt < 2) {
    var h = res.headers || {};
    var after = parseInt(h["retry-after"] || h["Retry-After"] || "0", 10);
    await sleep(after > 0 ? Math.min(after, 30) * 1000 : 1500 * (attempt + 1));
    return api(params, attempt + 1);
  }
  if (!res.ok) return {};
  try { return JSON.parse(res.body); } catch (e) { return {}; }
}

/* A "work" is a root page in the main namespace: no subpages (those are
 * the chapters) and no service pages. */
function isWork(title) {
  return !!title && title.indexOf("/") < 0 && title.indexOf(":") < 0 &&
         title !== mainPage;
}

/* The main page title changes with the language ("Pagina principale",
 * "Main Page"...), so ask the site instead of guessing: the filter then
 * holds for every edition. */
var mainPage = "";
var mainPageLoaded = false;

async function loadMainPage() {
  if (mainPageLoaded) return mainPage;
  var d = await api({ action: "query", meta: "siteinfo", siprop: "general" });
  mainPage = (d.query && d.query.general && d.query.general.mainpage) || "";
  mainPageLoaded = true;
  return mainPage;
}

function pageUrl(title) {
  return SITE + "/wiki/" + encodeURIComponent(title.replace(/ /g, "_"));
}

/* Covers are rare on Wikisource, but when they exist they are fetched
 * for the whole page of results in one call instead of one per book. */
async function coversFor(titles) {
  var map = {};
  if (!titles || !titles.length) return map;
  var d = await api({
    action: "query", prop: "pageimages", piprop: "thumbnail",
    pithumbsize: 400, titles: titles.slice(0, 50).join("|")
  });
  var pages = (d.query && d.query.pages) || [];
  for (var i = 0; i < pages.length; i++) {
    var th = pages[i].thumbnail && pages[i].thumbnail.source;
    if (th) map[pages[i].title] = th;
  }
  return map;
}

/* No cover lookup here on purpose. It costs an extra API call per page
 * — with the throttle in front of it, the slowest part of opening a
 * listing — and hardly any Wikisource work carries an image, so almost
 * every one of those calls came back empty. detail() still fetches it
 * for the one book actually being opened. */
function toBooks(titles) {
  var out = [];
  for (var i = 0; i < titles.length; i++) {
    var t = titles[i];
    out.push({ id: t, title: t, originalLanguage: LANG, siteUrl: pageUrl(t) });
  }
  return out;
}

/* --- listings ------------------------------------------------------- */

async function loadPopular() {
  if (popularCache) return popularCache;
  await loadMainPage();
  var out = [];
  try {
    var d = await api({ action: "query", list: "mostviewed", pvimlimit: 500 });
    var rows = (d.query && d.query.mostviewed) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.ns !== 0 || !isWork(r.title)) continue;
      if (out.indexOf(r.title) < 0) out.push(r.title);
    }
  } catch (e) { out = []; }
  popularCache = out;
  return out;
}

/* Fills the browse buffer. Starts from the literature category; if this
 * language has no such category, or it is empty, falls back to the
 * alphabetical list of every page. */
async function browseFill(need) {
  await loadMainPage();
  var guard = 0;
  while (!browseDone && browseBuffer.length < need && guard++ < 25) {
    var params, rows, cont;
    if (browseMode === "category") {
      params = { action: "query", list: "categorymembers",
                 cmtitle: BROWSE_CATEGORY, cmnamespace: 0, cmlimit: 100 };
      if (browseCont) params.cmcontinue = browseCont;
      var dc = await api(params);
      rows = (dc.query && dc.query.categorymembers) || [];
      cont = dc["continue"] && dc["continue"].cmcontinue;
      if (!rows.length && !browseBuffer.length) {
        browseMode = "allpages"; browseCont = null; continue;
      }
    } else {
      params = { action: "query", list: "allpages", apnamespace: 0,
                 apfilterredir: "nonredirects", aplimit: 100 };
      if (browseCont) params.apcontinue = browseCont;
      var da = await api(params);
      rows = (da.query && da.query.allpages) || [];
      cont = da["continue"] && da["continue"].apcontinue;
    }
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].title;
      if (isWork(t) && browseBuffer.indexOf(t) < 0) browseBuffer.push(t);
    }
    browseCont = cont || null;
    if (!browseCont) browseDone = true;
    if (!rows.length) break;
  }
  return browseBuffer;
}

/* --- chapters ------------------------------------------------------- */

var ROMAN = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };

function romanValue(s) {
  if (!/^[IVXLCDM]+$/.test(s)) return null;
  var total = 0;
  for (var i = 0; i < s.length; i++) {
    var v = ROMAN[s.charAt(i)];
    var next = i + 1 < s.length ? ROMAN[s.charAt(i + 1)] : 0;
    total += v < next ? -v : v;
  }
  return total;
}

/* The API returns chapters in alphabetical order, which gets Roman
 * numerals wrong (IX would land before V). Sort by value instead,
 * grouping by path first so that, say, the three canticles of the
 * Divine Comedy do not interleave on the canto number. Entries with no
 * number at all (Introduction, Preface...) keep the API's own order and
 * stay in front of their group. */
function sortChapters(list) {
  var keyed = [];
  for (var i = 0; i < list.length; i++) {
    var label = list[i].title;
    var cut = label.lastIndexOf("/");
    var prefix = cut < 0 ? "" : label.slice(0, cut);
    var tail = cut < 0 ? label : label.slice(cut + 1);
    var n = null;
    var m = tail.match(/([IVXLCDM]+)\s*$/);
    if (m) n = romanValue(m[1]);
    if (n === null) {
      var a = tail.match(/(\d+)/);
      if (a) n = parseInt(a[1], 10);
    }
    keyed.push({ item: list[i], prefix: prefix, n: n === null ? -1 : n, i: i });
  }
  keyed.sort(function (a, b) {
    if (a.prefix !== b.prefix) return a.prefix < b.prefix ? -1 : 1;
    if (a.n !== b.n) return a.n - b.n;
    return a.i - b.i;
  });
  var out = [];
  for (var k = 0; k < keyed.length; k++) {
    keyed[k].item.position = k;
    out.push(keyed[k].item);
  }
  return out;
}

/* --- text extraction ------------------------------------------------ */

/* Every Wikisource page opens with a Dublin Core metadata block
 * (<dc:title>, <dc:creator>...) that the API serves as visible HTML. It
 * is not part of the work and must be dropped. */
function isMetadata(t) {
  return t.indexOf("dc:title") >= 0 || t.indexOf("dc:creator") >= 0 ||
         t.indexOf("opt:role") >= 0;
}

async function pageText(title) {
  var d = await api({ action: "parse", page: title, prop: "text" });
  var html = (d.parse && d.parse.text) || "";
  if (!html) return { text: "", html: "" };
  var doc = await harbor.parseHtml(html);
  var root = doc.querySelector(".mw-parser-output");
  var scope = root || doc;
  var nodes = scope.querySelectorAll("p, blockquote, h2, h3, h4, dd");
  var parts = [];
  for (var i = 0; i < nodes.length; i++) {
    var t = nodes[i].text();
    if (!t || isMetadata(t)) continue;
    parts.push(t);
  }
  var text = parts.join("\n\n");
  /* Indexes, disambiguation pages and works laid out as lists have no
   * <p> at all: fall back to the whole container's text. root may be
   * missing, and HDocument exposes no text(), so guard the fallback. */
  if (text.length < 200 && root) {
    var whole = "";
    try { whole = root.text() || ""; } catch (e) { whole = ""; }
    if (!isMetadata(whole) && whole.length > text.length) text = whole;
  }
  return { text: text, html: html };
}

/* --- provider ------------------------------------------------------- */

var plugin = {
  id: SOURCE_ID,
  name: SOURCE_NAME,

  popular: async function (offset) {
    offset = offset || 0;
    var pop = await loadPopular();
    if (offset < pop.length) {
      return toBooks(pop.slice(offset, offset + PAGE_SIZE));
    }
    var rel = offset - pop.length;
    await browseFill(rel + PAGE_SIZE);
    return toBooks(browseBuffer.slice(rel, rel + PAGE_SIZE));
  },

  search: async function (query, offset) {
    offset = offset || 0;
    if (!query) return [];
    /* Harbor's offset counts the books handed back, the API's counts raw
     * hits. Several chapters collapse onto the same book, so the two
     * numbers drift apart: keep the mapping between them. */
    var key = query + "|" + offset;
    var apiOffset = searchCursors[key];
    if (apiOffset === undefined) apiOffset = offset;
    var d = await api({
      action: "query", list: "search", srsearch: query,
      srnamespace: 0, srlimit: PAGE_SIZE, sroffset: apiOffset
    });
    var rows = (d.query && d.query.search) || [];
    var titles = [];
    for (var i = 0; i < rows.length; i++) {
      var root = String(rows[i].title).split("/")[0];
      if (root.indexOf(":") >= 0) continue;
      if (titles.indexOf(root) < 0) titles.push(root);
    }
    searchCursors[query + "|" + (offset + titles.length)] = apiOffset + rows.length;
    return toBooks(titles);
  },

  detail: async function (id) {
    var got = await pageText(id);
    var author = "";
    var m = got.html.match(/dc:creator[^&]*&gt;([^&<]+)&lt;/);
    if (m) author = m[1].trim();
    /* Root pages are indexes, not blurbs: they rarely carry a real
     * synopsis, and the longest block is almost always the sister-project
     * pointer ("Wikipedia has an article about..."). No description beats
     * that one. */
    var desc = "";
    var chunks = got.text.split("\n\n");
    for (var i = 0; i < chunks.length && i < 12; i++) {
      var c = chunks[i].trim();
      if (/^(Wikipedia|Wikiquote|Wikimedia|Wikidata|Wikibooks|Commons)\b/.test(c)) continue;
      if (c.indexOf("voce di approfondimento") >= 0) continue;
      if (c.indexOf("has an article about") >= 0) continue;
      if (c.length > desc.length) desc = c;
    }
    if (desc.length < 40) desc = "";
    var cov = {};
    try { cov = await coversFor([id]); } catch (e) { cov = {}; }
    return {
      id: id, title: id,
      authors: author ? [author] : [],
      cover: cov[id],
      description: desc,
      originalLanguage: LANG,
      siteUrl: pageUrl(id)
    };
  },

  chapters: async function (id) {
    var d = await api({
      action: "query", list: "allpages", apprefix: id + "/",
      apnamespace: 0, apfilterredir: "nonredirects", aplimit: 500
    });
    var rows = (d.query && d.query.allpages) || [];
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i].title;
      out.push({ id: t, title: t.slice(id.length + 1) || t });
    }
    /* Poems and short pieces have no subpages: the work itself is its
     * one and only chapter. */
    if (!out.length) return [{ id: id, title: "Full text", position: 0 }];
    return sortChapters(out);
  },

  content: async function (chapterId) {
    var got = await pageText(chapterId);
    return got.text;
  }
};

harbor.register(plugin);
