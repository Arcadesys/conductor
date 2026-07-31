import { expect, test } from "@playwright/test";

test("desktop backlog preserves the approval gate and accessible shell", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page).toHaveTitle("Conductor");
  await expect(page.getByRole("heading", { name: "Epics", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve & dispatch", exact: true })).toBeVisible();
  await expect(page.getByText("Execution requires your approval", { exact: true })).toBeVisible();

  const audit = await page.evaluate(() => {
    const visibleButtons = [...document.querySelectorAll("button")].filter((button) => {
      const rect = button.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    return {
      bodyFont: Number.parseFloat(getComputedStyle(document.body).fontSize),
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      unnamedButtons: visibleButtons.filter(
        (button) => !(button.getAttribute("aria-label") || button.textContent?.trim() || button.title)
      ).length
    };
  });

  expect(audit.bodyFont).toBeGreaterThanOrEqual(18);
  expect(audit.overflowX).toBe(false);
  expect(audit.unnamedButtons).toBe(0);

  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to backlog", exact: true })).toBeFocused();
  const outline = await page.getByRole("link", { name: "Skip to backlog", exact: true }).evaluate(
    (element) => Number.parseFloat(getComputedStyle(element).outlineWidth)
  );
  expect(outline).toBeGreaterThanOrEqual(3);
});

test("board lets you start a Claude Code session from a selected ticket", async ({ page }) => {
  // Verifies the UX entry points exist and are wired up; deliberately never clicks
  // them through, since the dev server here runs against real project data and a
  // real click would spawn an actual Ghostty window or mutate a real git worktree.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.getByRole("button", { name: "Board", exact: true }).click();

  const card = page.locator(".board-column button").first();
  await expect(card).toBeVisible();
  await card.click();

  const sessionButton = page.getByRole("button", { name: "Start Claude Code session", exact: true });
  await expect(sessionButton).toBeVisible();
  await expect(sessionButton).toBeEnabled();

  const codexSessionButton = page.getByRole("button", { name: "Start Codex session", exact: true });
  await expect(codexSessionButton).toBeVisible();
  await expect(codexSessionButton).toBeEnabled();

  await card.click({ button: "right" });
  const sessionMenuItem = page.getByRole("menuitem", { name: "Start Claude Code session", exact: true });
  await expect(sessionMenuItem).toBeVisible();
  const codexSessionMenuItem = page.getByRole("menuitem", { name: "Start Codex session", exact: true });
  await expect(codexSessionMenuItem).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sessionMenuItem).toBeHidden();
  await expect(codexSessionMenuItem).toBeHidden();
});

test("200 percent layout collapses navigation and uses full-width issue detail", async ({ page }) => {
  await page.setViewportSize({ width: 720, height: 1000 });
  await page.goto("/");
  const inspector = page.locator('aside[aria-label$="details"]');
  await expect(inspector).toBeVisible();
  await expect(inspector).toHaveCSS("position", "fixed");

  const inspectorWidth = await inspector.evaluate((element) => element.getBoundingClientRect().width);
  expect(inspectorWidth).toBeGreaterThanOrEqual(719);

  await page.getByRole("button", { name: "Close issue details", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open navigation", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Epics", exact: true })).toBeVisible();

  const audit = await page.evaluate(() => {
    const nav = document.querySelector<HTMLElement>('[aria-label="Project navigation"]');
    return {
      navRight: nav?.getBoundingClientRect().right ?? 0,
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
    };
  });
  expect(audit.navRight).toBeLessThanOrEqual(0);
  expect(audit.overflowX).toBe(false);
});
