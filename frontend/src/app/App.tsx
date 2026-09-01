import { AppProviders } from "./providers";
import { CompactWindow } from "../windows/compact/CompactWindow";
import { MainWindow } from "../windows/main/MainWindow";
import { defaultBackend, type FrontendAdapter } from "../lib/backend";
import { identifyWindow, type AppWindowKind } from "../lib/window";

export interface AppProps {
  backend?: FrontendAdapter;
  windowKind?: AppWindowKind;
  location?: Pick<Location, "pathname" | "search" | "hash"> | string;
}

export default function App({
  backend = defaultBackend,
  windowKind,
  location,
}: AppProps) {
  const kind = windowKind ?? identifyWindow(location);
  return (
    <AppProviders backend={backend} transparentBackground={kind === "compact"}>
      {kind === "main" ? (
        <MainWindow backend={backend} />
      ) : (
        <CompactWindow backend={backend} />
      )}
    </AppProviders>
  );
}
