// Every operation the simulation can perform, one module per group.
import type { ActionModule } from "../types.ts";
import { creditActions } from "./credit.ts";
import { paymentActions } from "./payments.ts";
import { tokenActions } from "./token.ts";

export const MODULES: readonly ActionModule[] = [paymentActions, creditActions, tokenActions];
