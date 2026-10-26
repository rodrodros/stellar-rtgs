// Where the central bank's and the participants' own apps live, so the observer can link a bank
// to the app that acts as it. Set at build time; in dev they default to the apps' dev servers.

export type AppUrls = { centralBank?: string; participant?: string };

type AppEnv = { DEV?: boolean; VITE_RTGS_CENTRAL_BANK_APP_URL?: string; VITE_RTGS_PARTICIPANT_APP_URL?: string };

export function appUrls(env: AppEnv): AppUrls {
  return {
    centralBank: env.VITE_RTGS_CENTRAL_BANK_APP_URL || (env.DEV ? "http://localhost:5174/" : undefined),
    participant: env.VITE_RTGS_PARTICIPANT_APP_URL || (env.DEV ? "http://localhost:5175/" : undefined),
  };
}

/** The central bank's app, or the participant app acting as `bank` (it accepts an address). */
export function appLink(urls: AppUrls, role: "cb" | "bank", address: string): string | undefined {
  if (role === "cb") return urls.centralBank;
  if (!urls.participant) return undefined;
  const url = new URL(urls.participant, "http://localhost/");
  url.searchParams.set("bank", address);
  return /^https?:/.test(urls.participant) ? url.href : `${url.pathname}${url.search}`;
}
