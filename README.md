# Harbor eBook — personal sources

Plugins for Harbor's eBook section.

- **Wikisource** (`it`, `en`) — read through the official MediaWiki API: no CSS
  scraping that breaks on a redesign, and the same logic works for every
  language edition.
- **BookFrom.net** — HTML source, books served as paginated chunks.
- **Standard Ebooks** — downloads the `.epub` and unpacks it in the sandbox, so
  a whole book costs one request.

## Installing in Harbor

1. Push this folder to a public GitHub repository.
2. In Harbor: **eBook → sources → add repository**, paste the raw URL of
   `repo.json`:

   ```
   https://raw.githubusercontent.com/kalashnikxvxiii/harbor-ebook-plugins/master/repo.json
   ```

3. Install the plugins from the list.

The repository **must** live on a public domain. Harbor rejects `localhost` and
private IPs (`assertSafeUrl` in `plugins/host-http.ts`), so serving it from your
own network will not work.

## User-Agent

The Wikisource plugins identify themselves with:

```js
var UA = "HarborWikisourcePlugin/1.0 (personal reader; +https://github.com/kalashnikxvxiii/harbor-ebook-plugins)";
```

Wikimedia asks for a User-Agent that identifies the caller and is quick to
answer 429 without one. If you fork this repository, point that URL at your own
copy.

## Adding another language

Copy one of the `.js` files and change the four constants at the top:

```js
var LANG = "fr";
var SOURCE_ID = "wikisource-fr";
var SOURCE_NAME = "Wikisource (français)";
var BROWSE_CATEGORY = "Catégorie:Littérature";
```

Then add the entry to `repo.json`. A missing category is not a problem: the
plugin notices and falls back to the alphabetical list of every page.

## How it works

| method | approach |
|---|---|
| `popular` | `list=mostviewed`, filtered down to works; once exhausted, browses the category and then every page |
| `search` | `list=search`; hits that are chapters are folded back onto the work that contains them |
| `detail` | `action=parse` of the root page; the author comes from the Dublin Core metadata |
| `chapters` | `list=allpages` with an `Work/` prefix; with no subpages, the work is its own single chapter |
| `content` | `action=parse`, then the text of `p`, `blockquote`, `h2-h4` and `dd` is collected |

Two details that cost a debugging round:

- **The first `<p>` of every page is the Dublin Core block** (`<dc:title>`,
  `<dc:creator>`), served as visible HTML by the API. It is dropped by
  inspecting the text, because Harbor's CSS engine has no `:not()`.
- **Chapter order** arrives alphabetical, which gets Roman numerals wrong (`IX`
  before `V`). Entries are re-sorted by value, grouped by path first so the
  canticles of the *Divine Comedy* do not interleave on the canto number.

## BookFrom.net

The site serves a whole book as numbered HTML chunks:

```
/<author>/<id>-<slug>.html            chunk 1
/<author>/page,<n>,<id>-<slug>.html   chunk n
```

| method | approach |
|---|---|
| `popular` | `/fiction/` and `/fiction/page/N/`, 16 items a page |
| `search` | `/build_in_search/?q=…&page=N` — note the visible form on the site posts to a different path than the one that actually returns results |
| `detail` | the `<title>` carries `Title (Author) » p.1 »`, the cleanest place to read the author off a book page |
| `chapters` | only the highest `page,<n>,` link is read; the URLs in between are built rather than scraped, so a gap in the navigation cannot lose a chunk |
| `content` | `div.text#textToRead` on the raw HTML, with `<br>` turned into newlines |

Four things that needed fixing after the first run:

- **Listings and search return different link shapes** — genre pages use absolute
  URLs, the search endpoint relative ones. Both are normalised to a path, which
  doubles as the item id.
- **Search repeats a book** once per matching chunk, so results are deduplicated
  by path.
- **The first `<img>` on a book page is a tracking pixel**, not the cover; covers
  always come from the `picture.bookfrom.net` subdomain.
- **`div.showfull` is not the chapter, it is the page.** That class wraps the
  header and the search box too, so the first version leaked the site chrome
  into every chapter. The prose lives in `div.text#textToRead` — and the page
  carries *two* elements with that id, the first an empty copy left inside an
  HTML comment, so comments are stripped and the largest match wins.
  Extraction runs on the raw HTML rather than the parsed document: the sandbox
  only exposes `.text()`, which collapses whitespace and would weld the whole
  chapter into a single block. Rewriting `<br>` as newlines first keeps the
  paragraphing — barely ten `<p>` exist in an entire page.

## Standard Ebooks — the EPUB engine

This one does not scrape chapter pages. It fetches the `.epub` as base64,
reads the ZIP central directory, inflates entries with `DecompressionStream`,
then walks `META-INF/container.xml` → OPF → spine to get the reading order, and
the navigation document for chapter titles.

The machinery is deliberately kept apart from the few functions that locate a
book on the site. Pointing it at a different EPUB source means rewriting
`findEpubUrl` and the listing helpers, nothing else.

Measured on *Pride and Prejudice* (832 KB, 84 zip entries, 65 spine items):
download and unpack took 1083 ms, and a chapter served from the cached book
71 ms. One book is kept unpacked at a time, which spares a re-download per
chapter without letting the worker grow unbounded.

Three things worth knowing:

- **`Response` is removed from the sandbox**, so the usual
  `new Response(stream).arrayBuffer()` is unavailable. The inflate path drives
  `DecompressionStream`'s reader directly instead.
- **The OPF and navigation documents are parsed with regular expressions**, not
  `harbor.parseHtml`: an HTML parser mangles unknown XML elements differently on
  different engines, while the chapter XHTML itself parses fine.
- **The download link needs `?source=download`.** Without it the server returns
  an interstitial page that meta-refreshes to the real file, and the plugin gets
  8 KB of HTML instead of the book.

Both EPUB 2 (NCX) and EPUB 3 (nav) tables of contents are read, so the engine is
not tied to one generation of the format.

## Listing performance

All three plugins accumulate a listing per key and hand back fixed-size slices,
instead of returning whatever one page of the site happens to hold.

That started as a correctness fix. BookFrom's search answers with about a
hundred entries at once while a genre page carries sixteen, so returning a whole
page flooded the caller with covers and then advanced its cursor past everything
that followed — page two was computed as page seven, and the rest was never
seen.

Measured before and after, per call:

| | cold | repeat | search |
|---|---|---|---|
| Wikisource | 741 → 601 ms | 281 → **25 ms** | 472 → 238 ms |
| BookFrom | 1077 → 974 ms | 957 → **25 ms** | 100 items → 12 |
| Standard Ebooks | 622 → 521 ms | 255 → **25 ms** | 277 → 293 ms |

Two details behind those numbers:

- **Wikisource no longer looks up covers for a listing.** It cost an extra API
  call per page, sitting behind the rate-limit gap, and hardly any work on
  Wikisource carries an image, so nearly every one of those calls came back
  empty. `detail` still fetches it for the book actually being opened.
- **BookFrom serves twelve at a time, not sixteen.** A genre page holds sixteen
  articles but only fifteen books, so asking for sixteen forced a second fetch
  on every first page — which briefly made it slower, not faster.

## Known limitations

- **Poetry loses its line breaks.** The sandbox only exposes `.text()`, which
  collapses whitespace, so the `<br>` between verses disappears. There is no way
  around it without access to the inner HTML.
- **Verse numbers glue themselves to the text** (`interminati5Spazi`), because
  Wikisource puts them in inline elements.
- **Descriptions are almost always empty.** Root pages are indexes rather than
  blurbs; the only long block is the pointer to Wikipedia, which is dropped on
  purpose.
- **Covers are rare**: few works have an associated image.
- **Standard Ebooks' OPDS feed is not usable**: it answers 401, so listings are
  scraped from the HTML catalogue instead.

## Development

The source is copied into Harbor at install time and never refreshes on its own:
after each change the plugin has to be uninstalled and installed again. And
`harbor.log()` is discarded by the host, so inspecting a value means returning
it from one of the methods.

Tested by running the plugin inside Harbor's real sandbox (extracted from
`src/lib/manga/plugins/sandbox.ts`) against the live API, so the cut-down CSS
engine is exercised rather than a browser DOM.
