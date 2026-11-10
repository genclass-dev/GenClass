// A test that is still running when the command is interrupted (see the config next to it).
import { test } from "@playwright/test";

test("takes a minute", async () => {
  await new Promise((resolve) => setTimeout(resolve, 60_000));
});
