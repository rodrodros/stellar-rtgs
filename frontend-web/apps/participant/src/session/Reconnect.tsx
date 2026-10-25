import { createContext, useContext } from "react";

/** Reconnects to the current network with a new session (and so a new store). */
export const ReconnectContext = createContext<() => void>(() => {});

export const useReconnect = () => useContext(ReconnectContext);
