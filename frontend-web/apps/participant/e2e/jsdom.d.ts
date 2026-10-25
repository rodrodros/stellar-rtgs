// The one jsdom API e2e/dom.ts uses, instead of a dependency on @types/jsdom.
declare module "jsdom" {
  export class JSDOM {
    constructor(html?: string, options?: { url?: string });
    readonly window: Window & typeof globalThis;
  }
}
