/* Harbor eBook plugin — Liber Liber
 *
 * Curated Italian public-domain editions: fewer works than the Internet
 * Archive, but transcribed rather than scanned, so the text is clean and
 * the chapter divisions are real.
 *
 * Books are read from the ODT, which is a ZIP holding content.xml. That
 * file marks headings as <text:h> and paragraphs as <text:p>, which maps
 * onto chapters and their bodies directly — no guessing at where one
 * section ends, and no OCR noise. The PDF the site also offers is
 * unreadable here: there is no PDF parser in the sandbox.
 *
 * Opening a book walks four hops, because the file lives on a different
 * host than the catalogue:
 *   1. the work page              /autori/autori-<x>/<author>/<work>/
 *   2. its numeric id             op=<n> in that page
 *   3. the download page          /opere/download/?op=<n>&type=opera_url_odt
 *   4. the file itself            liberliber.eu/mediateca/libri/.../odt/
 *
 * Harbor sandbox constraints:
 *   - harbor.http is the only way out; Response and fetch are removed,
 *     so inflating drives DecompressionStream's reader directly
 *   - harbor.log() is discarded: debugging goes through return values
 */

var SITE = "https://liberliber.it";
var UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";
var PER_PAGE = 10;
var MAX_ODT_BYTES = 30 * 1024 * 1024;

var lastCallAt = 0;
var MIN_GAP_MS = 400;
var listCache = {};
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
      headers: { "User-Agent": UA, "Accept-Language": "it,en;q=0.8" },
      timeoutMs: 45000
    });
  } catch (e) {
    return null;
  }
  if (!res) return null;
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await sleep(2000 * (attempt + 1));
    return request(url, responseType, attempt + 1);
  }
  return res.ok ? res : null;
}

async function getHtml(path) {
  var res = await request(path, "text");
  return res && res.body ? res.body : "";
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

function base64ToBytes(b64) {
  var bin = atob(b64);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}


/* --- ODT ------------------------------------------------------------- */

var ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (whole, body) {
    if (body.charAt(0) === "#") {
      var code = body.charAt(1) === "x" || body.charAt(1) === "X"
        ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    var hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/* ODF marks runs of spaces, tabs and line breaks as empty elements
 * rather than literal characters, so they have to be put back before
 * the tags are stripped or words weld together. */
function odfText(fragment) {
  var s = fragment
    .replace(/<text:line-break\s*\/?>/gi, "\n")
    .replace(/<text:tab\s*\/?>/gi, " ")
    .replace(/<text:s\s+text:c="(\d+)"\s*\/?>/gi, function (m, n) {
      return new Array(parseInt(n, 10) + 1).join(" ");
    })
    .replace(/<text:s\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(s).replace(/[ \t ]+/g, " ").trim();
}

/* Walks content.xml in document order: every <text:h> opens a chapter,
 * every <text:p> adds a paragraph to the one in progress. Anything
 * before the first heading becomes the front matter chapter, so a work
 * without headings still yields one readable chapter. */
function parseOdt(xml) {
  var body = xml.indexOf("<office:body");
  if (body >= 0) xml = xml.slice(body);
  var re = /<text:(h|p)\b([^>]*)(?:\/>|>([\s\S]*?)<\/text:\1>)/g;
  var chapters = [];
  var current = { title: "", paragraphs: [] };
  var step;
  while ((step = re.exec(xml)) !== null) {
    var kind = step[1];
    var text = step[3] === undefined ? "" : odfText(step[3]);
    if (kind === "h") {
      if (current.title || current.paragraphs.length) chapters.push(current);
      current = { title: text, paragraphs: [] };
    } else if (text) {
      current.paragraphs.push(text);
    }
  }
  if (current.title || current.paragraphs.length) chapters.push(current);
  /* Headings with no body under them are covers and half-titles; they
   * would show as empty chapters in the reader. */
  var out = [];
  for (var i = 0; i < chapters.length; i++) {
    if (chapters[i].paragraphs.length) out.push(chapters[i]);
  }
  return out;
}

/* --- Liber Liber ----------------------------------------------------- */

var WORK_PATH = /^https?:\/\/liberliber\.it\/autori\/autori-[a-z]\/[^/]+\/[^/]+\/$/i;

function toId(url) { return url.replace(/^https?:\/\/liberliber\.it/i, ""); }
function toUrl(id) { return id.indexOf("http") === 0 ? id : SITE + id; }

function stripTags(s) {
  return decodeEntities(String(s).replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function worksFrom(html) {
  var out = [], seen = {};
  var re = /<h2[^>]*class="[^"]*entry-title[^"]*"[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  var m;
  while ((m = re.exec(html)) !== null) {
    var url = m[1];
    if (!WORK_PATH.test(url)) continue;
    var id = toId(url);
    if (seen[id]) continue;
    seen[id] = true;
    var bits = id.replace(/\/$/, "").split("/");
    out.push({
      id: id,
      title: stripTags(m[2]) || bits[bits.length - 1].replace(/-/g, " "),
      authors: [(bits[bits.length - 2] || "").replace(/-/g, " ")],
      originalLanguage: "it",
      siteUrl: toUrl(id)
    });
  }
  return out;
}

/* The site has no browsable list of works: the catalogue pages are
 * navigation, and the author index does not put the works in the HTML.
 * Search is the only door, so browsing rides on it too. */
async function serveList(key, makeUrl, offset) {
  var st = listCache[key];
  if (!st) st = listCache[key] = { items: [], seen: {}, nextPage: 1, done: false };
  var guard = 0;
  while (!st.done && st.items.length < offset + PER_PAGE && guard++ < 8) {
    var got = worksFrom(await getHtml(makeUrl(st.nextPage)));
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

function searchPath(query) {
  return function (page) {
    return "/" + (page > 1 ? "page/" + page + "/" : "") +
           "?s=" + encodeURIComponent(query);
  };
}

async function odtUrlFor(workId) {
  var page = await getHtml(workId);
  if (!page) return "";
  var op = page.match(/[?&]op=(\d+)/);
  if (!op) return "";
  /* The download page is a redirect shim: it answers with HTML that
   * carries the real address, on the liberliber.eu media host. */
  var shim = await getHtml("/opere/download/?op=" + op[1] + "&type=opera_url_odt");
  var file = shim.match(/https?:\/\/[^\s"']*\/odt\/[^\s"']+\.odt/i);
  return file ? file[0] : "";
}

async function loadBook(id) {
  if (openBook && openBook.id === id) return openBook;
  var url = await odtUrlFor(id);
  if (!url) return null;
  var res = await request(url, "base64");
  if (!res || !res.body) return null;
  var bytes = base64ToBytes(res.body);
  if (!bytes.length || bytes.length > MAX_ODT_BYTES) return null;
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) return null;
  var entries = readCentralDirectory(bytes);
  if (!entries) return null;
  var xml = await entryText({ bytes: bytes, entries: entries }, "content.xml");
  if (!xml) return null;
  var chapters = parseOdt(xml);
  if (!chapters.length) return null;
  openBook = { id: id, chapters: chapters };
  return openBook;
}

/* --- provider -------------------------------------------------------- */

var plugin = {
  id: "liberliber",
  name: "Liber Liber",

  popular: async function (offset) {
    return serveList("browse", searchPath("romanzo"), offset || 0);
  },

  search: async function (query, offset) {
    if (!query) return [];
    return serveList("query:" + query, searchPath(query), offset || 0);
  },

  detail: async function (id) {
    var bits = id.replace(/\/$/, "").split("/");
    var book = {
      id: id,
      title: (bits[bits.length - 1] || id).replace(/-/g, " "),
      authors: [(bits[bits.length - 2] || "").replace(/-/g, " ")],
      originalLanguage: "it",
      siteUrl: toUrl(id)
    };
    var page = await getHtml(id);
    if (!page) return book;
    var title = page.match(/<title>([\s\S]*?)<\/title>/i);
    if (title) {
      var clean = stripTags(title[1]).replace(/\s*[–—-]\s*Liber Liber\s*$/i, "").trim();
      if (clean) book.title = clean;
    }
    var cover = page.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);
    if (cover) book.cover = cover[1];
    var desc = page.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
    if (desc) book.description = stripTags(desc[1]);
    return book;
  },

  chapters: async function (id) {
    var book = await loadBook(id);
    if (!book) return [];
    var out = [];
    for (var i = 0; i < book.chapters.length; i++) {
      out.push({
        id: id + "|" + i,
        title: book.chapters[i].title || ("Parte " + (i + 1)),
        position: i
      });
    }
    return out;
  },

  content: async function (chapterId) {
    var cut = String(chapterId).lastIndexOf("|");
    if (cut < 0) return "";
    var book = await loadBook(chapterId.slice(0, cut));
    var index = parseInt(chapterId.slice(cut + 1), 10);
    if (!book || !(index >= 0) || index >= book.chapters.length) return "";
    return book.chapters[index].paragraphs.join("\n\n");
  }
};

harbor.register(plugin);
