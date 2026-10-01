# Observe 导航图标栏改造 设计

## 背景

tracing-dashboard 追加的 Observe 导航（对话 / Overview / Trace / Ops）塞在侧边栏底部，字号小、无图标、与会话列表挤在一起，观感差且无法调整。

## 方案

左侧常驻图标栏（IconRail）+ 会话列表（可拖拽调宽）+ 主内容区，三栏结构（VS Code 式）。

## 布局

- App 骨架：`grid-template-columns: 44px auto minmax(0, 1fr)`
- IconRail（44px 宽，从上到下）：对话图标 → 分隔线 → Overview / Trace / Ops 图标 → 弹性空间 → 折叠按钮
- 折叠语义变化：图标栏常驻，折叠按钮只把会话列表宽度收为 0（按钮 aria-label 仍为「折叠侧边栏 / 展开侧边栏」）
- 选中项用现有 `--dsw-specific-sidebar-nav-item-active` 高亮；图标带 `title` tooltip 与 `aria-label`

## 拖拽调宽

- 会话列表右边缘 6px 热区（`.sidebar-resizer`，`cursor: col-resize`）
- 范围 200–400px；结果写 `localStorage["blh.sidebar-width"]`，刷新保持
- 拖拽中根节点加 `app-dragging` 类禁用宽度过渡动画；折叠时隐藏热区

## 代码改动

1. 新增 `apps/web/src/components/IconRail.tsx`：纯展示组件，props 为 `route / collapsed / onToggle`
2. `icons.tsx`：新增 `IconChat / IconGauge / IconTrace / IconSliders`（16px 网格，currentColor）
3. `SessionSidebar.tsx`：删除 observe-nav 区块、`route` / `collapsed` / `onToggle` 相关折叠逻辑
4. `App.tsx`：三栏 grid、宽度 state + pointer 拖拽、collapsed 仅控制会话列表宽度
5. `styles.css`：新增 `.icon-rail / .rail-link / .rail-divider / .rail-spacer / .sidebar-resizer`；`.sidebar` 改为 `width: var(--sidebar-width)` + 宽度过渡；删除 `.observe-nav*` 与全部 `.sidebar-collapsed` 规则

## 测试

- 现有 e2e 选择器均为 `getByRole("link"/"button", { name })`，图标栏保留相同 aria-label，旧用例零改动
- `observe.spec.ts` 新增：图标栏 active 高亮断言
- `workbench.spec.ts` 新增：拖拽调宽后刷新保持
