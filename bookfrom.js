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
var PER_PAGE = 16;
var UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";

var lastCallAt = 0;
var MIN_GAP_MS = 300;

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

async function getDoc(path, attempt) {
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
    return getDoc(path, attempt + 1);
  }
  if (!res.ok || !res.body) return null;
  return await harbor.parseHtml(res.body);
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

function textOf(doc) {
  if (!doc) return "";
  var box = doc.querySelector("div.showfull");
  if (!box) return "";
  var nodes = box.querySelectorAll("p");
  var parts = [];
  for (var i = 0; i < nodes.length; i++) {
    var t = nodes[i].text();
    if (t) parts.push(t);
  }
  var text = parts.join("\n\n");
  /* Some chunks are laid out with <br> instead of paragraphs, which
   * leaves no <p> to collect: fall back to the container itself. */
  if (text.length < 200) {
    var whole = "";
    try { whole = box.text() || ""; } catch (e) { whole = ""; }
    if (whole.length > text.length) text = whole;
  }
  return text;
}

/* --- provider ------------------------------------------------------- */

var plugin = {
  id: "bookfrom",
  name: "BookFrom.net",

  popular: async function (offset) {
    offset = offset || 0;
    var page = Math.floor(offset / PER_PAGE) + 1;
    var path = "/" + BROWSE_GENRE + "/" + (page > 1 ? "page/" + page + "/" : "");
    return itemsFrom(await getDoc(path));
  },

  search: async function (query, offset) {
    if (!query) return [];
    offset = offset || 0;
    var page = Math.floor(offset / PER_PAGE) + 1;
    var path = "/build_in_search/?q=" + encodeURIComponent(query) +
               (page > 1 ? "&page=" + page : "");
    return itemsFrom(await getDoc(path));
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
    return textOf(await getDoc(chapterId));
  }
};

harbor.register(plugin);
