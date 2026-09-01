export interface EmittedChunk {
  isEntry: boolean;
  imports: readonly string[];
}

export type EmittedChunkGraph = ReadonlyMap<string, EmittedChunk>;

/** Finds static-import cycles reachable from an application or dynamic entry. */
export function findEntryChunkCycle(graph: EmittedChunkGraph): string[] | null {
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const stackIndexes = new Map<string, number>();

  const visit = (fileName: string): string[] | null => {
    const chunk = graph.get(fileName);
    if (!chunk) return null;

    const currentState = state.get(fileName);
    if (currentState === "visiting") {
      const cycleStart = stackIndexes.get(fileName) ?? 0;
      return [...stack.slice(cycleStart), fileName];
    }
    if (currentState === "visited") return null;

    state.set(fileName, "visiting");
    stackIndexes.set(fileName, stack.length);
    stack.push(fileName);
    for (const importedFile of [...chunk.imports].sort()) {
      const cycle = visit(importedFile);
      if (cycle) return cycle;
    }
    stack.pop();
    stackIndexes.delete(fileName);
    state.set(fileName, "visited");
    return null;
  };

  const entries = [...graph.entries()]
    .filter(([, chunk]) => chunk.isEntry)
    .map(([fileName]) => fileName)
    .sort();
  for (const entry of entries) {
    const cycle = visit(entry);
    if (cycle) return cycle;
  }
  return null;
}
