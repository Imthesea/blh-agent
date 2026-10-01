import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:18123/api/__reset");
});

test("图标栏显示主导航", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "对话" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Trace" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ops" })).toBeVisible();
});

test("图标栏根据路由高亮当前页", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await expect(page.getByRole("link", { name: "Trace" })).toHaveClass(/active/);
  await expect(page.getByRole("link", { name: "对话" })).not.toHaveClass(/active/);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "对话" })).toHaveClass(/active/);
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

test("Overview 页显示统计卡片、成本图与最近 turns", async ({ page }) => {
  await page.goto("/#/observe/overview");
  await expect(page.locator(".stat-card", { hasText: "总花费" })).toContainText("$0.4200");
  await expect(page.locator(".stat-card", { hasText: "今日 turns" })).toContainText("3");
  await expect(page.locator(".stat-card", { hasText: "平均延迟" })).toContainText("1.5s");
  await expect(page.locator(".cost-bar-col")).toHaveCount(2);
  await expect(page.getByText("查一下 trace 文件")).toBeVisible();
});

test("Trace 页显示日期/会话选择器与 turn 卡片", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await expect(page.locator(".trace-toolbar select").first()).toBeVisible();
  await expect(page.getByText("查一下 trace 文件")).toBeVisible();
  await expect(page.locator(".trace-llm-row")).toContainText("deepseek-chat");
  await expect(page.locator(".trace-tool-row")).toContainText("read_file");
  await expect(page.getByText("进行中")).toBeVisible();
});

test("Trace 页展开工具行显示输出摘要", async ({ page }) => {
  await page.goto("/#/observe/trace");
  await page.locator(".trace-tool-row button").click();
  await expect(page.getByText("file content")).toBeVisible();
});

test("Ops 页显示成本表、审批表与 trace 原文", async ({ page }) => {
  await page.goto("/#/observe/ops");
  await expect(
    page.locator(".observe-section").filter({ hasText: "按 provider" }).locator(".ops-table"),
  ).toContainText("deepseek");
  await expect(page.locator(".ops-approval")).toContainText("allow");
  await expect(page.locator(".ops-approval")).toContainText("1");
  await expect(page.locator(".ops-raw")).toContainText("turn_start");
  await expect(page.locator(".ops-slowest")).toContainText("查一下 trace 文件");
});
