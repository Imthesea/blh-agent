import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:8123/api/__reset");
});

test("侧边栏显示 Observe 导航区", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Trace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ops" })).toBeVisible();
});

test("点击 Trace 链接切换 hash 并显示 Trace 页", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Trace" }).click();
  await expect(page).toHaveURL(/#\/observe\/trace$/);
  await expect(page.getByRole("heading", { name: "Trace" })).toBeVisible();
});

test("从观测页返回对话", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await page.getByRole("link", { name: "对话" }).click();
  await expect(page).toHaveURL(/#\/$/);
  await expect(page.getByPlaceholder("输入消息…")).toBeVisible();
});

test("深链接直接打开 Ops 页", async ({ page }) => {
  await page.goto("/#/observe/ops");
  await expect(page.getByRole("heading", { name: "Ops" })).toBeVisible();
});
