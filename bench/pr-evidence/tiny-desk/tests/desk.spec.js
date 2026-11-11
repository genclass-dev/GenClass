import { test, expect } from "@playwright/test";

for (const v of ["buggy", "fixed"]) {
  test.describe(v, () => {
    const open = async (page, request, w) => {
      await request.post("/api/reset");
      await page.goto(`/?w=${w}&v=${v}`);
      await expect(page.getByTestId("header")).toContainText("signed in as demo");
    };

    test("search shows the last query's results", async ({ page, request }) => {
      await open(page, request, "search");
      const box = page.getByLabel("Search");
      await box.pressSequentially("react", { delay: 80 });
      await expect(page.getByTestId("results")).toContainText("react lamp");
      await page.getByRole("button", { name: "react lamp" }).click();
      await expect(page.getByTestId("picked")).toHaveText("Picked: react lamp");
    });

    test("checkout places the order", async ({ page, request }) => {
      await open(page, request, "checkout");
      await page.getByRole("button", { name: "Place order" }).dblclick();
      await expect(page.getByTestId("order-status")).toHaveText("Order placed");
      await expect(page.getByTestId("order-total")).toContainText("Orders on file");
    });

    test("detail shows the item picked last", async ({ page, request }) => {
      await open(page, request, "detail");
      await page.getByRole("button", { name: "lamp" }).click();
      await page.getByRole("button", { name: "desk" }).click();
      await expect(page.getByTestId("detail-title")).toHaveText("Desk");
      await expect(page.getByTestId("detail-price")).toHaveText("$249");
    });

    test("profile keeps what was typed", async ({ page, request }) => {
      await open(page, request, "profile");
      const box = page.getByLabel("Display name");
      await box.pressSequentially("Ada Lovelace", { delay: 60 });
      await expect(page.getByTestId("saved")).toHaveText("Saved");
      await expect(box).toHaveValue("Ada Lovelace");
    });

    test("cart counts two adds", async ({ page, request }) => {
      await open(page, request, "cart");
      const add = page.getByRole("button", { name: "Add to cart" });
      await add.click();
      await add.click();
      await expect(page.getByTestId("cart")).toHaveText("2 in cart");
    });
  });
}
