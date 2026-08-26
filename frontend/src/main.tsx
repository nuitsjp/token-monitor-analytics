import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createFakeBackend } from "./lib/backend";
import "./styles.css";

const search = new URLSearchParams(window.location.search);
const browserTestBackend = import.meta.env.DEV
  ? search.has("showcase")
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
