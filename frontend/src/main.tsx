import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createFakeBackend } from "./lib/backend";
import "./styles.css";

const search = new URLSearchParams(window.location.search);
const useMockHub =
  import.meta.env.DEV &&
  (import.meta.env.VITE_MOCK_HUB === "1" || search.has("showcase"));
const browserTestEnabled =
  import.meta.env.DEV || import.meta.env.VITE_BROWSER_TEST === "1";
const browserTestBackend = browserTestEnabled
  ? useMockHub
    ? (await import("./lib/showcase")).createShowcaseBackend()
    : search.has("browserTest")
      ? createFakeBackend({ canOpenMain: true })
      : undefined
  : undefined;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App backend={browserTestBackend} />
  </React.StrictMode>,
);
