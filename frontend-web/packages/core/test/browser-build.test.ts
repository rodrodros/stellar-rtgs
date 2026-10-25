// Core is consumed as TypeScript source by the apps' Vite builds; this checks that it bundles
// for the browser: the Wasm becomes an asset, and the wallet kit stays in its own lazy chunk.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, describe, expect, it } from "vitest";

const out = mkdtempSync(join(tmpdir(), "rtgs-core-build-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("browser build", () => {
  it("bundles with the Wasm as an asset and the wallet kit split out", async () => {
    await build({
      configFile: false,
      logLevel: "silent",
      root: fileURLToPath(new URL("./browser", import.meta.url)),
      build: { outDir: out, minify: false, assetsInlineLimit: 0 },
    });
    const files = readdirSync(out, { recursive: true }).map(String);
    const wasm = files.find((f) => f.endsWith(".wasm"));
    expect(wasm).toBeDefined();
    expect(readFileSync(join(out, wasm!)).subarray(0, 4)).toEqual(Buffer.from([0, 0x61, 0x73, 0x6d]));
    const scripts = files.filter((f) => f.endsWith(".js"));
    const html = readFileSync(join(out, "index.html"), "utf8");
    const entry = scripts.find((f) => html.includes(f.split("/").pop()!))!;
    // The wallet kit's own chunks are loaded with a dynamic import, only when a wallet connects.
    expect(scripts.length).toBeGreaterThan(1);
    expect(readFileSync(join(out, entry), "utf8")).toMatch(/import\(["'`]\.\/sdk-[\w-]+\.js["'`]\)/);
  }, 120_000);
});
