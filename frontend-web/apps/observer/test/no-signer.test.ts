// The observer holds no keys and signs nothing, on any network. Its code reaches core only
// through src/core.ts, which re-exports no signer, actor or token admin.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const src = fileURLToPath(new URL("../src", import.meta.url));
const files = (readdirSync(src, { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))
  .map((f) => ({ path: relative(src, join(src, f)), text: readFileSync(join(src, f), "utf8") }));

const SIGNING = /\b(connectWallet|keypairSigner|devnetIdentities|deriveDevnetKeypair|TokenAdmin|RtgsActor|Signer|tokenAdmin|bootstrapDevnet)\b|\.as\(|stellar-wallets-kit|@stellar\/stellar-sdk/;

describe("no signing in the observer", () => {
  it("imports @rtgs/core only through src/core.ts", () => {
    const importers = files.filter((f) => /from "@rtgs\/core(\/[\w-]+)?"/.test(f.text)).map((f) => f.path);
    expect(importers).toEqual(["core.ts"]);
  });

  it("names nothing that signs", () => {
    for (const f of files) expect(f.text, f.path).not.toMatch(SIGNING);
  });
});
