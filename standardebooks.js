/* Harbor eBook plugin — Standard Ebooks (EPUB reader)
 *
 * Unlike the other plugins here, this one does not scrape chapter pages:
 * it downloads the .epub and unpacks it inside the sandbox, so the whole
 * book comes from a single request.
 *
 * That machinery — ZIP central directory, raw-deflate, OPF spine, nav
 * titles — is deliberately kept separate from the handful of functions
 * that locate a book on the site. Pointing this at another EPUB source
 * means rewriting only findEpubUrl / the listing helpers.
 *
 * Harbor sandbox constraints:
 *   - harbor.http is the only way out; Response and fetch are removed,
 *     so inflating goes through DecompressionStream's reader directly
 *     rather than the usual new Response(stream).arrayBuffer()
 *   - harbor.log() is discarded: debugging goes through return values
 */

var SITE = "https://standardebooks.org";
var UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";
var PER_PAGE = 12;
var MAX_EPUB_BYTES = 25 * 1024 * 1024;

var lastCallAt = 0;
var MIN_GAP_MS = 300;

/* Listings are accumulated per key and served in slices, so paging back
 * to a listing already fetched costs nothing. */
var listCache = {};

/* One book is kept unpacked in memory. Harbor reads a book's chapters
 * one after another, so a single slot spares a re-download per chapter
 * without letting the worker grow unbounded. */
var openBook = null;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function request(url, responseType, attempt) {
  attempt = attempt || 0;
  var gap = lastCallAt + MIN_GAP_MS - Date.now();
  if (gap > 0) await sleep(gap);
  lastCallAt = Date.now();

  var res;
  try {
    res = await harbor.http(url.indexOf("http") === 0 ? url : SITE + url, {
      responseType: responseType || "text",
      headers: { "User-Agent": UA },
      timeoutMs: 30000
    });
  } catch (e) {
    return null;
  }
  if (!res) return null;
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return request(url, responseType, attempt + 1);
  }
  return res.ok ? res : null;
}

async function getDoc(path) {
  var res = await request(path, "text");
  return res && res.body ? await harbor.parseHtml(res.body) : null;
}

/* --- ZIP ------------------------------------------------------------ */

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216;
}

/* The end-of-central-directory record sits at the tail, after a comment
 * of unknown length, so it has to be searched for backwards. */
function findEocd(b) {
  var min = Math.max(0, b.length - 66000);
  for (var i = b.length - 22; i >= min; i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 0x05 && b[i + 3] === 0x06) return i;
  }
  return -1;
}

function readCentralDirectory(b) {
  var eocd = findEocd(b);
  if (eocd < 0) return null;
  var count = u16(b, eocd + 10);
  var offset = u32(b, eocd + 16);
  var entries = {};
  var p = offset;
  for (var i = 0; i < count && p + 46 <= b.length; i++) {
    if (u32(b, p) !== 0x02014b50) break;
    var method = u16(b, p + 10);
    var compSize = u32(b, p + 20);
    var nameLen = u16(b, p + 28);
    var extraLen = u16(b, p + 30);
    var commentLen = u16(b, p + 32);
    var localOff = u32(b, p + 42);
    var name = "";
    for (var k = 0; k < nameLen; k++) name += String.fromCharCode(b[p + 46 + k]);
    entries[decodeURIComponent(escape(name))] = {
      method: method, compSize: compSize, localOff: localOff
    };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function inflateRaw(bytes) {
  var ds = new DecompressionStream("deflate-raw");
  var writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  var reader = ds.readable.getReader();
  var chunks = [], total = 0;
  for (;;) {
    var step = await reader.read();
    if (step.done) break;
    chunks.push(step.value);
    total += step.value.length;
  }
  var out = new Uint8Array(total), at = 0;
  for (var i = 0; i < chunks.length; i++) { out.set(chunks[i], at); at += chunks[i].length; }
  return out;
}

async function readEntry(zip, name) {
  var e = zip.entries[name];
  if (!e) return null;
  var b = zip.bytes;
  /* The central directory's name/extra lengths are not always the ones
   * in the local header, so the data offset must be recomputed here. */
  if (u32(b, e.localOff) !== 0x04034b50) return null;
  var start = e.localOff + 30 + u16(b, e.localOff + 26) + u16(b, e.localOff + 28);
  var raw = b.subarray(start, start + e.compSize);
  if (e.method === 0) return raw;
  if (e.method === 8) return await inflateRaw(raw);
  return null;
}

function decodeText(bytes) {
  if (!bytes) return "";
  try { return new TextDecoder("utf-8").decode(bytes); } catch (e) {}
  var s = "";
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(s)); } catch (e2) { return s; }
}

async function entryText(zip, name) {
  return decodeText(await readEntry(zip, name));
}

/* --- EPUB ----------------------------------------------------------- */

function resolvePath(base, rel) {
  if (!rel) return "";
  rel = rel.split("#")[0];
  if (rel.charAt(0) === "/") return rel.slice(1);
  var parts = base.split("/");
  parts.pop();
  var bits = rel.split("/");
  for (var i = 0; i < bits.length; i++) {
    if (bits[i] === "." || bits[i] === "") continue;
    if (bits[i] === "..") parts.pop();
    else parts.push(bits[i]);
  }
  return parts.join("/");
}

function attr(tag, name) {
  var m = tag.match(new RegExp(name + '\\s*=\\s*"([^"]*)"'));
  return m ? m[1] : "";
}

/* The OPF and the nav document are XML. They are read with regular
 * expressions rather than harbor.parseHtml, because an HTML parser
 * mangles unknown XML elements differently on different engines. */
function parseOpf(xml, opfPath) {
  var manifest = {};
  var navHref = "", ncxHref = "";
  var items = xml.match(/<item\b[^>]*>/g) || [];
  for (var i = 0; i < items.length; i++) {
    var id = attr(items[i], "id");
    var href = attr(items[i], "href");
    if (!id || !href) continue;
    var full = resolvePath(opfPath, href);
    manifest[id] = full;
    var props = attr(items[i], "properties");
    if (props.indexOf("nav") >= 0) navHref = full;
    if (attr(items[i], "media-type").indexOf("dtbncx") >= 0) ncxHref = full;
  }
  var spine = [];
  var refs = xml.match(/<itemref\b[^>]*>/g) || [];
  for (var j = 0; j < refs.length; j++) {
    var idref = attr(refs[j], "idref");
    if (manifest[idref]) spine.push(manifest[idref]);
  }
  return { spine: spine, navHref: navHref, ncxHref: ncxHref };
}

/* Chapter labels come from the navigation document. EPUB 3 uses a nav
 * with plain anchors, EPUB 2 an NCX; both are handled so the plugin is
 * not tied to one generation of the format. */
function parseNavTitles(xml, navPath) {
  var map = {};
  if (!xml) return map;
  var anchors = xml.match(/<a\b[^>]*href\s*=\s*"[^"]*"[^>]*>[\s\S]*?<\/a>/g) || [];
  for (var i = 0; i < anchors.length; i++) {
    var href = attr(anchors[i], "href");
    var label = anchors[i].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (href && label) {
      var key = resolvePath(navPath, href);
      if (!map[key]) map[key] = label;
    }
  }
  var points = xml.match(/<navPoint\b[\s\S]*?<\/navPoint>/g) || [];
  for (var j = 0; j < points.length; j++) {
    var t = points[j].match(/<text>([\s\S]*?)<\/text>/);
    var c = points[j].match(/<content\b[^>]*src\s*=\s*"([^"]*)"/);
    if (t && c) {
      var k2 = resolvePath(navPath, c[1]);
      var lab = t[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      if (lab && !map[k2]) map[k2] = lab;
    }
  }
  return map;
}

function base64ToBytes(b64) {
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadBook(bookId) {
  if (openBook && openBook.id === bookId) return openBook;
  var url = await findEpubUrl(bookId);
  if (!url) return null;
  var res = await request(url, "base64");
  if (!res || !res.body) return null;
  var bytes = base64ToBytes(res.body);
  if (!bytes.length || bytes.length > MAX_EPUB_BYTES) return null;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;

  var entries = readCentralDirectory(bytes);
  if (!entries) return null;
  var zip = { bytes: bytes, entries: entries };

  var container = await entryText(zip, "META-INF/container.xml");
  var m = container.match(/full-path\s*=\s*"([^"]+)"/);
  if (!m) return null;
  var opfPath = m[1];
  var opf = parseOpf(await entryText(zip, opfPath), opfPath);
  if (!opf.spine.length) return null;

  var navPath = opf.navHref || opf.ncxHref;
  var titles = navPath ? parseNavTitles(await entryText(zip, navPath), navPath) : {};

  openBook = { id: bookId, zip: zip, spine: opf.spine, titles: titles };
  return openBook;
}

/* --- site: the only part tied to Standard Ebooks -------------------- */

function bookPathOf(href) {
  if (!href) return "";
  var i = href.indexOf("standardebooks.org");
  var p = i >= 0 ? href.slice(href.indexOf("/", i)) : href;
  p = p.split("#")[0].split("?")[0];
  var m = p.match(/^(\/ebooks\/[^/]+\/[^/]+)/);
  return m ? m[1] : "";
}

function itemsFrom(doc) {
  var out = [], seen = {};
  if (!doc) return out;
  var links = doc.querySelectorAll('a[property="schema:url"]');
  for (var i = 0; i < links.length; i++) {
    var path = bookPathOf(links[i].attr("href"));
    if (!path || seen[path]) continue;
    seen[path] = true;
    /* "/ebooks/<author>/<title>" splits into ["", "ebooks", author,
     * title] — four pieces, so the slugs sit at 2 and 3. */
    var bits = path.split("/");
    var slugAuthor = (bits[2] || "").replace(/-/g, " ");
    var slugTitle = (bits[3] || "").replace(/-/g, " ");
    out.push({
      id: path,
      title: (links[i].text() || slugTitle).trim(),
      authors: [slugAuthor],
      cover: SITE + path + "/downloads/cover-thumbnail.jpg",
      siteUrl: SITE + path
    });
  }
  return out;
}

/* The download page is an interstitial that meta-refreshes to the same
 * URL with ?source=download; without that parameter the server hands
 * back the interstitial instead of the file. */
async function findEpubUrl(bookPath) {
  var doc = await getDoc(bookPath);
  if (!doc) return "";
  var links = doc.querySelectorAll("a");
  var best = "";
  for (var i = 0; i < links.length; i++) {
    var h = links[i].attr("href") || "";
    if (h.slice(-5) !== ".epub") continue;
    if (h.indexOf(".kepub.") >= 0 || h.indexOf("_advanced") >= 0) continue;
    best = h;
    break;
  }
  if (!best) return "";
  if (best.charAt(0) === "/") best = SITE + best;
  return best + (best.indexOf("?") >= 0 ? "&" : "?") + "source=download";
}

/* --- provider ------------------------------------------------------- */

async function serveList(key, makeUrl, offset) {
  var st = listCache[key];
  if (!st) st = listCache[key] = { items: [], seen: {}, nextPage: 1, done: false };
  var guard = 0;
  while (!st.done && st.items.length < offset + PER_PAGE && guard++ < 8) {
    var got = itemsFrom(await getDoc(makeUrl(st.nextPage)));
    st.nextPage++;
    if (!got.length) { st.done = true; break; }
    for (var i = 0; i < got.length; i++) {
      if (st.seen[got[i].id]) continue;
      st.seen[got[i].id] = true;
      st.items.push(got[i]);
    }
  }
  return st.items.slice(offset, offset + PER_PAGE);
}

var plugin = {
  id: "standardebooks",
  name: "Standard Ebooks",

  popular: async function (offset) {
    return serveList("all", function (page) { return "/ebooks?page=" + page; }, offset || 0);
  },

  search: async function (query, offset) {
    if (!query) return [];
    return serveList("query:" + query, function (page) {
      return "/ebooks?query=" + encodeURIComponent(query) + "&page=" + page;
    }, offset || 0);
  },

  detail: async function (id) {
    var doc = await getDoc(id);
    var bits = id.split("/");
    var book = {
      id: id,
      title: (bits[3] || id).replace(/-/g, " "),
      authors: [(bits[2] || "").replace(/-/g, " ")],
      cover: SITE + id + "/downloads/cover-thumbnail.jpg",
      siteUrl: SITE + id
    };
    if (!doc) return book;
    var h1 = doc.querySelector("h1");
    if (h1 && h1.text()) book.title = h1.text().trim();
    var desc = doc.querySelector("section#description p") || doc.querySelector("p");
    if (desc && desc.text()) book.description = desc.text().trim();
    return book;
  },

  chapters: async function (id) {
    var book = await loadBook(id);
    if (!book) return [];
    var out = [];
    for (var i = 0; i < book.spine.length; i++) {
      var path = book.spine[i];
      out.push({
        id: id + "|" + i,
        title: book.titles[path] || ("Section " + (i + 1)),
        position: i
      });
    }
    return out;
  },

  content: async function (chapterId) {
    var cut = String(chapterId).lastIndexOf("|");
    if (cut < 0) return "";
    var bookId = chapterId.slice(0, cut);
    var index = parseInt(chapterId.slice(cut + 1), 10);
    var book = await loadBook(bookId);
    if (!book || !(index >= 0) || index >= book.spine.length) return "";
    var xhtml = await entryText(book.zip, book.spine[index]);
    if (!xhtml) return "";
    var doc = await harbor.parseHtml(xhtml);
    var body = doc.querySelector("section") || doc.querySelector("body") || doc;
    var nodes = body.querySelectorAll("p, h1, h2, h3, h4, blockquote, li");
    var parts = [];
    for (var i = 0; i < nodes.length; i++) {
      var t = nodes[i].text();
      if (t) parts.push(t);
    }
    return parts.join("\n\n");
  }
};

harbor.register(plugin);
