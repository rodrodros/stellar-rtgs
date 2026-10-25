// A browser entry that uses what an app would: built by browser-build.test.ts.
import { connectWallet, loadNetworks, loadSettlementWasm } from "../../src/index.ts";
import { RtgsProvider } from "../../src/react/index.tsx";

Object.assign(globalThis, { connectWallet, loadNetworks, loadSettlementWasm, RtgsProvider });
