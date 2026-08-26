import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { createKeyborg } from "keyborg";
import { afterEach, vi } from "vitest";

afterEach(cleanup);

// Fluent UI initialises keyborg lazily (for example when a Tooltip portal
// mounts) and keyborg replaces `HTMLElement.prototype.focus`. user-event
// redefines the same property as a getter, so a lazy initialisation after
// `userEvent.setup()` throws. Initialising it up-front keeps both usable.
createKeyborg(window);

Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
Object.defineProperty(window, "ResizeObserver", {
  configurable: true,
  writable: true,
  value: TestResizeObserver,
});
