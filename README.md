# Harbor eBook — personal sources

Plugins for Harbor's eBook section.

- **Wikisource** (`it`, `en`) — read through the official MediaWiki API: no CSS
  scraping that breaks on a redesign, and the same logic works for every
  language edition.
- **BookFrom.net** — HTML source, books served as paginated chunks.

## Installing in Harbor

1. Push this folder to a public GitHub repository.
2. In Harbor: **eBook → sources → add repository**, paste the raw URL of
   `repo.json`:

   ```
   https://raw.githubusercontent.com/kalashnikxvxiii/harbor-ebook-plugins/main/repo.json
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
| `content` | `div.showfull`, collecting `p` and falling back to the container when a chunk uses `<br>` instead of paragraphs |

Three things that needed fixing after the first run:

- **Listings and search return different link shapes** — genre pages use absolute
  URLs, the search endpoint relative ones. Both are normalised to a path, which
  doubles as the item id.
- **Search repeats a book** once per matching chunk, so results are deduplicated
  by path.
- **The first `<img>` on a book page is a tracking pixel**, not the cover; covers
  always come from the `picture.bookfrom.net` subdomain.

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

## Development

The source is copied into Harbor at install time and never refreshes on its own:
after each change the plugin has to be uninstalled and installed again. And
`harbor.log()` is discarded by the host, so inspecting a value means returning
it from one of the methods.

Tested by running the plugin inside Harbor's real sandbox (extracted from
`src/lib/manga/plugins/sandbox.ts`) against the live API, so the cut-down CSS
engine is exercised rather than a browser DOM.
