import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Mirror the tsconfig `@/*` -> project-root alias so tests import the same way
  // app code does.
  resolve: {
    alias: { "@": root },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    clearMocks: true,
    // lib/db.ts opens its SQLite file at import time; point it at an in-memory
    // DB so tests never touch the real one. A throwaway YouTube key lets the
    // youtube.ts helpers run against mocked fetch without throwing.
    env: {
      DB_PATH: ":memory:",
      YOUTUBE_API_KEY: "test-key",
    },
  },
});
