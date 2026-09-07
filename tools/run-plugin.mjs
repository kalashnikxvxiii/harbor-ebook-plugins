import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
const S = new URL(".", import.meta.url).pathname;
// The sandbox is not vendored: it is lifted from a local Harbor checkout,
// so the plugin is always exercised against the engine Harbor actually ships.
const harborRepo = process.env.HARBOR_REPO || `${process.env.HOME}/Documenti/GitHub/harbor`;
const sandboxTs = readFileSync(`${harborRepo}/src/lib/manga/plugins/sandbox.ts`, "utf8");
const sandboxSrc = sandboxTs.slice(
  sandboxTs.indexOf("String.raw`") + "String.raw`".length,
  sandboxTs.lastIndexOf("`"),
);
const pluginSrc  = readFileSync(process.argv[2], "utf8");

let onmsg = null;
const inbox = [];
const self = {
  postMessage: (m) => inbox.push(m),
  close: () => {},
  set onmessage(fn) { onmsg = fn; },
  get onmessage() { return onmsg; },
  set onerror(_) {},
};
globalThis.self = self;
globalThis.btoa = (s) => Buffer.from(s, "binary").toString("base64");
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
new Function(sandboxSrc)();

const send = (m) => onmsg({ data: m });

async function pump() {
  while (inbox.length) {
    const m = inbox.shift();
    if (m.type === "http") {
      try {
        const r = await fetch(m.payload.url, {
          method: m.payload.opts.method || "GET",
          headers: m.payload.opts.headers || {},
        });
        let body;
        if (m.payload.opts.responseType === "base64") {
          const buf = Buffer.from(await r.arrayBuffer());
          body = buf.toString("base64");
        } else {
          body = await r.text();
        }
        send({ type: "bridgeResult", id: m.id, ok: true,
               value: { status: r.status, ok: r.ok, headers: {}, body } });
      } catch (e) {
        send({ type: "bridgeResult", id: m.id, ok: false, error: String(e) });
      }
    } else if (m.type === "parse") {
      const tree = execFileSync("python3", [`${S}/serialize.py`],
        { input: m.payload.html, maxBuffer: 64 * 1024 * 1024 }).toString();
      send({ type: "bridgeResult", id: m.id, ok: true, value: JSON.parse(tree) });
    } else if (m.type === "ready" || m.type === "result" ||
               m.type === "error" || m.type === "initError") {
      return m;
    }
  }
  return null;
}
async function wait() {
  for (let i = 0; i < 4000; i++) {
    const r = await pump();
    if (r) return r;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("timeout");
}
send({ type: "init", source: pluginSrc, config: {} });
const ready = await wait();
if (ready.type === "initError") { console.log("INIT ERROR:", ready.error); process.exit(1); }
console.log("  provider:", ready.meta.id, "|", ready.meta.name);
console.log("  metodi:", ready.meta.methods.join(", "));

let seq = 0;
async function call(method, args) {
  send({ type: "call", id: "c" + ++seq, method, args });
  const r = await wait();
  if (r.type === "error") throw new Error(r.error);
  return r.value;
}
export { call };
globalThis.__call = call;
const script = process.argv[3];
if (script) {
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  await (await import(pathToFileURL(resolve(script)).href)).default(call);
}
