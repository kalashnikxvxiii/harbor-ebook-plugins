# Testing a plugin

Runs a plugin inside Harbor's real sandbox — the same cut-down CSS engine and
the same bridge, lifted from a local Harbor checkout rather than vendored here,
so a plugin is never validated against a browser DOM it will not get.

```bash
node tools/run-plugin.mjs liberliber.js tools/probe.mjs
QUERY="verga" node tools/run-plugin.mjs wikisource-it.js tools/probe.mjs
```

`HARBOR_REPO` points at the Harbor checkout (defaults to
`~/Documenti/GitHub/harbor`). Python 3 is used to turn HTML into the node tree
the sandbox expects, mirroring `host-parse.ts`.

`probe.mjs` calls every required method in turn and reports counts, timings and
the first few results. It flags the one failure that is easy to miss: content
returned without blank lines between paragraphs, which leaves Harbor's reader
unable to scroll.
