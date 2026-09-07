/* Harbor eBook plugin — Internet Archive
 *
 * The largest Italian holding reachable from a reader: 432k texts with
 * full text, behind a real search API rather than a scraped catalogue.
 *
 * Books are read from the OCR transcript, <id>_djvu.txt, split into
 * sections of roughly equal length: it has no chapter structure at all.
 *
 * The epub route was tried first and dropped. Archive's epubs are
 * generated from the page scans — one XHTML per page, 1134 of them for
 * a single novel, most with no extractable text — so the transcript is
 * both cleaner and cheaper. The EPUB engine still lives in
 * standardebooks.js, where the files are made by hand and worth it.
 *
 * Change LANG / SOURCE_ID / SOURCE_NAME for another language edition.
 *
 * Harbor sandbox constraints:
 *   - harbor.http is the only way out; Response and fetch are removed,
 *     so inflating drives DecompressionStream's reader directly
 *   - harbor.log() is discarded: debugging goes through return values
 */

var LANG = "english";
var SOURCE_ID = "archive-en";
var SOURCE_NAME = "Internet Archive (English)";

var SITE = "https://archive.org";
var UA = "HarborArchivePlugin/1.0 (personal reader; +https://github.com/kalashnikxvxiii/harbor-ebook-plugins)";
var PER_PAGE = 12;
var MAX_TEXT_BYTES = 12 * 1024 * 1024;
/* Sections are cut at roughly this length, on a paragraph boundary. A
 * scanned novel runs to millions of characters; handing that over as a
 * single chapter would blow past Harbor's 6 MB cache entry limit and
 * give the reader one endless page. */
var SECTION_CHARS = 40000;

/* Lending-only scans have no downloadable transcript, so they are
 * filtered out at the query rather than failing later on open. */
var BASE_QUERY = "language:(" + LANG + ") AND mediatype:(texts)" +
  " AND NOT access-restricted-item:(true) AND format:(DjVuTXT)" +
  /* Sorting by downloads otherwise puts newspaper issues and magazine
   * scans at the top of a book listing. */
  " AND NOT collection:(periodicals) AND NOT collection:(magazine_rack)" +
  " AND NOT collection:(mensmagazines_post70s) AND NOT collection:(pulpmagazinearchive)";

var lastCallAt = 0;
var MIN_GAP_MS = 300;
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
      headers: { "User-Agent": UA },
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

async function getJson(url) {
  var res = await request(url, "text");
  if (!res || !res.body) return null;
  try { return JSON.parse(res.body); } catch (e) { return null; }
}

/* --- Internet Archive ------------------------------------------------ */

function itemUrl(id) { return SITE + "/details/" + encodeURIComponent(id); }
function coverUrl(id) { return SITE + "/services/img/" + encodeURIComponent(id); }

function firstOf(value) {
  if (Array.isArray(value)) return value.length ? String(value[0]) : "";
  return value === undefined || value === null ? "" : String(value);
}

/* Archive metadata is uneven: a description can be a stray "1", a
 * number, or a block of HTML. Anything too short to be a sentence is
 * dropped rather than shown. */
function cleanDescription(value) {
  var text = firstOf(value).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text.length >= 20 ? text : "";
}

function docsToBooks(docs) {
  var out = [];
  for (var i = 0; i < docs.length; i++) {
    var id = firstOf(docs[i].identifier);
    var title = firstOf(docs[i].title);
    if (!id || !title) continue;
    var creator = docs[i].creator;
    var authors = Array.isArray(creator)
      ? creator.map(String)
      : (creator ? [String(creator)] : []);
    out.push({
      id: id,
      title: title,
      authors: authors,
      cover: coverUrl(id),
      year: typeof docs[i].year === "number" ? docs[i].year : undefined,
      originalLanguage: "en",
      siteUrl: itemUrl(id)
    });
  }
  return out;
}

async function searchPage(query, sort, page) {
  var url = SITE + "/advancedsearch.php?q=" + encodeURIComponent(query) +
    "&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=creator&fl%5B%5D=year" +
    (sort ? "&sort%5B%5D=" + encodeURIComponent(sort) : "") +
    "&rows=" + PER_PAGE + "&page=" + page + "&output=json";
  var data = await getJson(url);
  var docs = data && data.response && data.response.docs;
  return Array.isArray(docs) ? docsToBooks(docs) : [];
}

/* Listings are accumulated per key and served in fixed-size slices, so
 * paging back to one already fetched costs nothing. */
async function serveList(key, query, sort, offset) {
  var st = listCache[key];
  if (!st) st = listCache[key] = { items: [], seen: {}, nextPage: 1, done: false };
  var guard = 0;
  while (!st.done && st.items.length < offset + PER_PAGE && guard++ < 8) {
    var got = await searchPage(query, sort, st.nextPage);
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

async function metadataOf(id) {
  return await getJson(SITE + "/metadata/" + encodeURIComponent(id));
}

function pickFile(meta, suffix) {
  var files = (meta && meta.files) || [];
  for (var i = 0; i < files.length; i++) {
    var name = String(files[i].name || "");
    if (name.slice(-suffix.length).toLowerCase() === suffix) return name;
  }
  return "";
}

function downloadUrl(id, file) {
  return SITE + "/download/" + encodeURIComponent(id) + "/" +
         file.split("/").map(encodeURIComponent).join("/");
}

/* The OCR transcript is one unbroken run — no page markers survive the
 * conversion — so it is cut into sections at paragraph boundaries. */
function splitSections(text) {
  var paragraphs = text.replace(/\r/g, "").split(/\n{2,}/);
  var sections = [], current = [], size = 0;
  for (var i = 0; i < paragraphs.length; i++) {
    var p = paragraphs[i].replace(/[ \t]+/g, " ").trim();
    if (!p) continue;
    current.push(p);
    size += p.length + 2;
    if (size >= SECTION_CHARS) {
      sections.push(current.join("\n\n"));
      current = []; size = 0;
    }
  }
  if (current.length) sections.push(current.join("\n\n"));
  return sections.length ? sections : [""];
}

async function loadBook(id) {
  if (openBook && openBook.id === id) return openBook;
  var meta = await metadataOf(id);
  if (!meta) return null;

  /* The OCR transcript, not the epub. Archive's epubs are generated
   * from the scans: one XHTML per page, 1134 of them for a single
   * novel, and most carry no extractable text at all. The transcript is
   * one clean continuous run and sections far better. */
  var txtName = pickFile(meta, "_djvu.txt");
  if (!txtName) return null;
  var got = await request(downloadUrl(id, txtName), "text");
  if (!got || !got.body || got.body.length > MAX_TEXT_BYTES) return null;
  openBook = { id: id, kind: "text", sections: splitSections(got.body) };
  return openBook;
}

/* --- provider -------------------------------------------------------- */

var plugin = {
  id: SOURCE_ID,
  name: SOURCE_NAME,

  popular: async function (offset) {
    return serveList("popular", BASE_QUERY, "downloads desc", offset || 0);
  },

  search: async function (query, offset) {
    if (!query) return [];
    var q = BASE_QUERY + " AND (" + String(query).replace(/[()"]/g, " ") + ")";
    return serveList("query:" + query, q, "", offset || 0);
  },

  detail: async function (id) {
    var meta = await metadataOf(id);
    var md = (meta && meta.metadata) || {};
    var creator = md.creator;
    return {
      id: id,
      title: firstOf(md.title) || id,
      authors: Array.isArray(creator) ? creator.map(String)
                                      : (creator ? [String(creator)] : []),
      cover: coverUrl(id),
      description: cleanDescription(md.description),
      year: md.year ? parseInt(md.year, 10) : undefined,
      originalLanguage: "en",
      siteUrl: itemUrl(id)
    };
  },

  chapters: async function (id) {
    var book = await loadBook(id);
    if (!book) return [];
    var out = [];
    if (book.kind === "epub") {
      for (var i = 0; i < book.spine.length; i++) {
        out.push({
          id: id + "|" + i,
          title: book.titles[book.spine[i]] || ("Section " + (i + 1)),
          position: i
        });
      }
      return out;
    }
    for (var j = 0; j < book.sections.length; j++) {
      out.push({ id: id + "|" + j, title: "Part " + (j + 1),
                 chapter: String(j + 1), position: j });
    }
    return out;
  },

  content: async function (chapterId) {
    var cut = String(chapterId).lastIndexOf("|");
    if (cut < 0) return "";
    var id = chapterId.slice(0, cut);
    var index = parseInt(chapterId.slice(cut + 1), 10);
    var book = await loadBook(id);
    if (!book || !(index >= 0)) return "";
    if (book.kind === "text") return book.sections[index] || "";
    if (index >= book.spine.length) return "";
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
