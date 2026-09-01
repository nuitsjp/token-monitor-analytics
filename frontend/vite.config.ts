import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import wails from "@wailsio/runtime/plugins/vite";
import {
  findEntryChunkCycle,
  type EmittedChunk,
} from "./src/build/chunkGraph.ts";

function rejectEntryChunkCycles(): Plugin {
  return {
    name: "reject-entry-chunk-cycles",
    apply: "build",
    enforce: "post",
    generateBundle(_, bundle) {
      const graph = new Map<string, EmittedChunk>();
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        graph.set(output.fileName, {
          isEntry: output.isEntry || output.isDynamicEntry,
          imports: output.imports,
        });
      }
      const cycle = findEntryChunkCycle(graph);
      if (cycle) {
        this.error(`Production chunk import cycle: ${cycle.join(" -> ")}`);
      }
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [react(), wails("./bindings"), rejectEntryChunkCycles()],
});
