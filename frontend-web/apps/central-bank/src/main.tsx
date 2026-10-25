import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { buildEnv } from "./env.ts";
import { AppSessionProvider } from "./session/AppSession.tsx";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppSessionProvider env={buildEnv}>
      <App />
    </AppSessionProvider>
  </StrictMode>,
);
