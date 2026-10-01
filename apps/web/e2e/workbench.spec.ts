import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  await request.post("http://127.0.0.1:18123/api/__reset");
});

test("工作台加载并显示品牌标识", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("blh", { exact: true })).toBeVisible();
});

test("发送消息后展示流式回复", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("你好");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("你好，世界")).toBeVisible();
});

test("工具调用展示工具卡片", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("请用工具");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("read_file")).toBeVisible();
  await expect(page.getByText("file content")).toBeVisible();
});

test("审批弹窗出现并可允许", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("请审批");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "允许", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("错误事件展示错误横幅", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("触发错误");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByText("模拟错误")).toBeVisible();
});

test("审批等待时输入禁用", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("请审批");
  await page.getByRole("button", { name: "发送" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByPlaceholder("输入消息…")).toBeDisabled();
});

test("折叠侧边栏", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "折叠侧边栏" }).click();
  await expect(page.getByRole("button", { name: "展开侧边栏" })).toBeVisible();
});

test("拖拽调整会话列表宽度并持久化", async ({ page }) => {
  await page.goto("/");
  const sidebar = page.locator(".sidebar");
  await expect(sidebar).toHaveCSS("width", "280px");
  const resizer = page.locator(".sidebar-resizer");
  const box = await resizer.boundingBox();
  if (box === null) throw new Error("resizer 不可见");
  await page.mouse.move(box.x + box.width / 2, box.y + 300);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + 300, { steps: 5 });
  await page.mouse.up();
  await expect(sidebar).toHaveCSS("width", "360px");
  await page.reload();
  await expect(page.locator(".sidebar")).toHaveCSS("width", "360px");
});

test("悬停会话显示三点并可删除", async ({ page }) => {
  await page.goto("/");
  const row = page.getByText("历史会话");
  await row.hover();
  await page.getByRole("button", { name: "会话操作", exact: true }).click();
  await page.getByRole("menuitem", { name: "删除会话" }).click();
  await expect(page.getByText("历史会话")).toHaveCount(0);
});

test("回复中显示停止按钮，点击后中断并标记已中断", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder("输入消息…").fill("请中断");
  await page.getByRole("button", { name: "发送" }).click();
  const stopButton = page.getByRole("button", { name: "停止" });
  await expect(stopButton).toBeVisible();
  await stopButton.click();
  await expect(page.getByText("(已中断)")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送" })).toBeVisible();
});
