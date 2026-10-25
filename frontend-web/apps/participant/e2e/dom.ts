// A DOM for the e2e test, installed before anything imports React. Vitest's jsdom environment
// replaces realm globals that @stellar/stellar-sdk checks bytes against, so this suite runs in
// the Node environment and copies over only what Node lacks (document, window, the element
// classes, storage, MutationObserver, ...). Node keeps its own typed arrays, URL and fetch.
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/" });
const { window } = dom;
const own = new Set(["window", "document"]);
for (const key of Object.getOwnPropertyNames(window)) {
  if (key in globalThis || own.has(key)) continue;
  Object.defineProperty(globalThis, key, { configurable: true, get: () => (window as unknown as Record<string, unknown>)[key] });
}
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
