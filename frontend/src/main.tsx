import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { createFakeBackend } from "./lib/backend";
import "./styles.css";

const browserTestBackend =
  import.meta.env.DEV &&
  new URLSearchParams(window.location.search).has("browserTest")
    ? createFakeBackend({ canOpenMain: true })
    : undefined;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App backend={browserTestBackend} />
  </React.StrictMode>,
);
