// genclass's tests (test/genclass.test.ts): Node only, nothing to build. ci.yml's runtime job runs them.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
});
