export type AppWindowKind = "compact" | "main";

type LocationLike = Pick<Location, "pathname" | "search" | "hash">;

function normalize(value: string | null): string {
  return (value ?? "").trim().toLowerCase();
}

function kindFromValue(value: string): AppWindowKind | undefined {
  if (["t01", "compact", "compact-top", "top"].includes(value)) {
    return "compact";
  }
  if (["m00", "main", "window-main"].includes(value)) return "main";
  return undefined;
}

function readSearch(search: string): AppWindowKind | undefined {
  const params = new URLSearchParams(
    search.startsWith("?") ? search : `?${search}`,
  );
  for (const key of ["window", "windowKind", "view", "screen"]) {
    const kind = kindFromValue(normalize(params.get(key)));
    if (kind) return kind;
  }
  return undefined;
}

function lastPathSegment(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : "";
}

/** Resolve the Wails initial URL without exposing window IDs in the UI. */
export function identifyWindow(
  location: LocationLike | string = window.location,
): AppWindowKind {
  if (typeof location === "string") {
    const parsed = new URL(location, "http://localhost");
    return (
      readSearch(parsed.search) ??
      readSearch(
        parsed.hash.includes("?")
          ? parsed.hash.slice(parsed.hash.indexOf("?"))
          : "",
      ) ??
      kindFromValue(normalize(lastPathSegment(parsed.pathname))) ??
      "compact"
    );
  }
  return (
    readSearch(location.search) ??
    readSearch(
      location.hash.includes("?")
        ? location.hash.slice(location.hash.indexOf("?"))
        : "",
    ) ??
    kindFromValue(normalize(lastPathSegment(location.pathname))) ??
    "compact"
  );
}
