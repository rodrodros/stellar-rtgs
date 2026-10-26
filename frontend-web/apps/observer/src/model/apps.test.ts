import { describe, expect, it } from "vitest";
import { appLink, appUrls } from "./apps.ts";

const BANK = `G${"B".repeat(55)}`;

describe("app links", () => {
  it("defaults to the dev servers in dev, and to nothing in a build", () => {
    expect(appUrls({ DEV: true })).toEqual({ centralBank: "http://localhost:5174/", participant: "http://localhost:5175/" });
    expect(appUrls({})).toEqual({ centralBank: undefined, participant: undefined });
  });

  it("links the central bank to its app and a bank to the participant app acting as it", () => {
    const urls = appUrls({ VITE_RTGS_CENTRAL_BANK_APP_URL: "/central-bank/", VITE_RTGS_PARTICIPANT_APP_URL: "https://x.test/participant/" });
    expect(appLink(urls, "cb", "G")).toBe("/central-bank/");
    expect(appLink(urls, "bank", BANK)).toBe(`https://x.test/participant/?bank=${BANK}`);
    expect(appLink({ participant: "/participant/" }, "bank", BANK)).toBe(`/participant/?bank=${BANK}`);
    expect(appLink({}, "bank", BANK)).toBeUndefined();
  });
});
