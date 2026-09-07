/* Harbor eBook plugin — BookFrom.net
 *
 * The site serves whole books as paginated HTML, one chunk per page:
 *   book page          /<author>/<id>-<slug>.html            (chunk 1)
 *   further chunks     /<author>/page,<n>,<id>-<slug>.html
 * Text lives in a single container, div.page.showfull.
 *
 * Two shapes of the same link have to be handled: genre listings use
 * absolute URLs, the search endpoint relative ones.
 *
 * Harbor sandbox constraints:
 *   - harbor.http is the only way out; no fetch, no DOM
 *   - the CSS engine knows tag/.class/#id/[attr] and ' ' / '>' only:
 *     no :not(), no :nth-child(), no sibling combinators
 *   - harbor.log() is discarded, so debugging goes through return values
 */

var SITE = "https://www.bookfrom.net";
var BROWSE_GENRE = "fiction";
/* A genre page carries 16 articles but only 15 are books, so asking for
 * 16 forced a second fetch for every first page. Twelve fits inside one
 * fetch and leaves headroom if a page comes back short. */
var PER_PAGE = 12;
var UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";

var lastCallAt = 0;
var MIN_GAP_MS = 300;

/* Listings are accumulated per key and served in slices. The site does
 * not hand back a fixed page size — a genre page carries 16 entries but
 * a search answers with a hundred at once — so returning a whole page
 * flooded the caller with covers and then advanced its cursor past
 * everything that followed. Fetching once and slicing keeps the page
 * size honest and makes going back to a listing free. */
var listCache = {};

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function getRaw(path, attempt) {
  attempt = attempt || 0;
  var gap = lastCallAt + MIN_GAP_MS - Date.now();
  if (gap > 0) await sleep(gap);
  lastCallAt = Date.now();

  var url = path.indexOf("http") === 0 ? path : SITE + path;
  var res;
  try {
    res = await harbor.http(url, {
      responseType: "text",
      headers: { "User-Agent": UA, "Accept-Language": "en;q=0.9" },
      timeoutMs: 20000
    });
  } catch (e) {
    return null;
  }
  if (!res) return null;
  if ((res.status === 429 || res.status === 503) && attempt < 2) {
    await sleep(1500 * (attempt + 1));
    return getRaw(path, attempt + 1);
  }
  if (!res.ok || !res.body) return null;
  return res.body;
}

async function getDoc(path) {
  var body = await getRaw(path);
  return body ? await harbor.parseHtml(body) : null;
}

/* Both link shapes collapse to the same id: the path alone. */
function toPath(href) {
  if (!href) return "";
  var i = href.indexOf("bookfrom.net");
  if (i >= 0) return href.slice(href.indexOf("/", i));
  return href.charAt(0) === "/" ? href : "/" + href;
}

function isBookPath(p) {
  return /^\/[a-z0-9-]+\/\d+-[^/]+\.html$/i.test(p);
}

/* A listing item: article.box.story, with the book in h2.title a, the
 * author in the one link that points at an author folder, and the cover
 * in the first img. */
function itemsFrom(doc) {
  var out = [];
  var seen = {};
  if (!doc) return out;
  var arts = doc.querySelectorAll("article.story");
  for (var i = 0; i < arts.length; i++) {
    var art = arts[i];
    var link = art.querySelector("h2.title a");
    if (!link) continue;
    var path = toPath(link.attr("href"));
    /* The search endpoint lists the same book more than once when
     * several of its chunks match the query. */
    if (!isBookPath(path) || seen[path]) continue;
    seen[path] = true;
    var title = (link.text() || "").trim();
    if (!title) continue;

    var author = "";
    var anchors = art.querySelectorAll("a");
    for (var j = 0; j < anchors.length; j++) {
      var hp = toPath(anchors[j].attr("href"));
      if (/^\/[a-z0-9-]+\/$/i.test(hp) && hp !== "/") {
        var t = anchors[j].attr("title") || "";
        var m = t.match(/author\s*[-–]\s*(.+)$/i);
        author = m ? m[1].trim() : anchors[j].text().trim();
        if (author) break;
      }
    }
    var img = art.querySelector("img");
    var cover = img ? img.attr("src") : null;
    if (cover && cover.indexOf("picture.bookfrom.net") < 0) cover = null;

    out.push({
      id: path,
      title: title,
      authors: author ? [author] : [],
      cover: cover && cover.indexOf("cleardot") < 0 ? cover : undefined,
      siteUrl: SITE + path
    });
  }
  return out;
}

/* --- chapters ------------------------------------------------------- */

/* The book page is chunk 1 and links to the rest as page,<n>,<file>.
 * Only the highest number is needed: the URLs in between are built,
 * not scraped, so a gap in the navigation cannot lose a chunk. */
function chunkUrls(doc, bookPath) {
  var max = 1;
  var anchors = doc.querySelectorAll("a");
  for (var i = 0; i < anchors.length; i++) {
    var p = toPath(anchors[i].attr("href"));
    var m = p.match(/\/page,(\d+),/);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n > max) max = n;
    }
  }
  var cut = bookPath.lastIndexOf("/");
  var dir = bookPath.slice(0, cut + 1);
  var file = bookPath.slice(cut + 1);
  var out = [bookPath];
  for (var k = 2; k <= max; k++) out.push(dir + "page," + k + "," + file);
  return out;
}

/* --- text ----------------------------------------------------------- */

/* The prose is NOT in div.showfull: that class wraps the whole page,
 * header and search box included, which is why an early version leaked
 * the site chrome into the first chapter. The chapter lives in
 * div.text#textToRead, and it holds bare text nodes separated by <br>
 * rather than paragraphs — barely ten <p> exist in the entire page.
 *
 * That is also why the extraction works on the raw HTML instead of the
 * parsed document: the sandbox only exposes .text(), which collapses
 * whitespace and would weld every line into one block. Turning <br>
 * into newlines first keeps the paragraphing intact. */
var ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "\u2026", mdash: "\u2014", ndash: "\u2013", rsquo: "\u2019",
  lsquo: "\u2018", ldquo: "\u201c", rdquo: "\u201d", eacute: "\u00e9"
};

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, function (whole, body) {
    if (body.charAt(0) === "#") {
      var code = body.charAt(1) === "x" || body.charAt(1) === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    var hit = ENTITIES[body.toLowerCase()];
    return hit === undefined ? whole : hit;
  });
}

/* Walks div nesting from an opening tag to its own closing tag, so a
 * container holding other divs is cut at the right place.
 *
 * Every match is tried and the biggest fragment wins: the page carries
 * two elements with this id, and the first is an empty one left inside
 * an HTML comment. Picking the first match silently returned 24 bytes. */
function sliceContainer(html, openRe) {
  var re = new RegExp(openRe.source, "gi");
  var best = "", m;
  while ((m = re.exec(html)) !== null) {
    var from = m.index + m[0].length;
    var scan = /<\/?div\b[^>]*>/gi;
    scan.lastIndex = from;
    var depth = 1, step, frag = null;
    while ((step = scan.exec(html)) !== null) {
      depth += step[0].charAt(1) === "/" ? -1 : 1;
      if (depth === 0) { frag = html.slice(from, step.index); break; }
    }
    if (frag === null) frag = html.slice(from);
    if (frag.length > best.length) best = frag;
    re.lastIndex = from;
  }
  return best;
}

function htmlToText(fragment) {
  var s = fragment
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  s = decodeEntities(s).replace(/\r/g, "");
  var lines = s.split("\n");
  for (var i = 0; i < lines.length; i++) {
    lines[i] = lines[i].replace(/[ \t\u00a0]+/g, " ").trim();
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function textOf(html) {
  if (!html) return "";
  /* Comments first: the commented-out copy of the container would
   * otherwise be a candidate. */
  html = html.replace(/<!--[\s\S]*?-->/g, " ");
  var body = sliceContainer(html, /<div\b[^>]*id\s*=\s*"textToRead"[^>]*>/i);
  if (!body) body = sliceContainer(html, /<div\b[^>]*class\s*=\s*"[^"]*\btext\b[^"]*"[^>]*>/i);
  return htmlToText(body);
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
  id: "bookfrom",
  name: "BookFrom.net",

  popular: async function (offset) {
    return serveList("genre:" + BROWSE_GENRE, function (page) {
      return "/" + BROWSE_GENRE + "/" + (page > 1 ? "page/" + page + "/" : "");
    }, offset || 0);
  },

  search: async function (query, offset) {
    if (!query) return [];
    return serveList("query:" + query, function (page) {
      return "/build_in_search/?q=" + encodeURIComponent(query) +
             (page > 1 ? "&page=" + page : "");
    }, offset || 0);
  },

  detail: async function (id) {
    var doc = await getDoc(id);
    var book = { id: id, title: id, siteUrl: SITE + id };
    if (!doc) return book;

    var h = doc.querySelector("h1") || doc.querySelector("h2.title");
    if (h) book.title = (h.text() || "").trim() || id;
    /* The page title carries "Title (Author) » p.1 » ..." — the cleanest
     * place to read the author off a book page. */
    var t = doc.querySelector("title");
    if (t) {
      var m = (t.text() || "").match(/^(.*?)\s*\(([^)]+)\)/);
      if (m) {
        if (!book.title || book.title === id) book.title = m[1].trim();
        book.authors = [m[2].trim()];
      }
    }
    /* The first <img> on a book page is a tracking pixel or the site
     * logo. Covers are always served from the picture. subdomain. */
    var imgs = doc.querySelectorAll("img");
    for (var i = 0; i < imgs.length; i++) {
      var src = imgs[i].attr("src") || "";
      if (src.indexOf("picture.bookfrom.net") >= 0 && src.indexOf("cleardot") < 0) {
        book.cover = src;
        break;
      }
    }
    return book;
  },

  chapters: async function (id) {
    var doc = await getDoc(id);
    if (!doc) return [{ id: id, title: "Page 1", position: 0 }];
    var urls = chunkUrls(doc, id);
    var out = [];
    for (var i = 0; i < urls.length; i++) {
      out.push({ id: urls[i], title: "Page " + (i + 1), chapter: String(i + 1), position: i });
    }
    return out;
  },

  content: async function (chapterId) {
    return textOf(await getRaw(chapterId));
  }
};

harbor.register(plugin);
