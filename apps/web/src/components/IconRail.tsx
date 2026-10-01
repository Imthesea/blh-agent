import { IconChat, IconGrid, IconPanelLeft, IconSliders, IconTrace } from "./icons";

/** 左侧常驻图标栏：主导航（对话 / Overview / Trace / Ops）+ 底部会话列表折叠开关。 */
export function IconRail(props: { route: string; collapsed: boolean; onToggle(): void }) {
  const { route, collapsed, onToggle } = props;
  const chatActive = route === "" || route === "#/";
  return (
    <nav className="icon-rail" aria-label="主导航">
      <a className={`rail-link${chatActive ? " active" : ""}`} href="#/" aria-label="对话" data-tip="对话">
        <IconChat size={18} />
      </a>
      <span className="rail-divider" />
      <a
        className={`rail-link${route === "#/observe/overview" ? " active" : ""}`}
        href="#/observe/overview"
        aria-label="Overview"
        data-tip="Overview"
      >
        <IconGrid size={18} />
      </a>
      <a
        className={`rail-link${route === "#/observe/trace" ? " active" : ""}`}
        href="#/observe/trace"
        aria-label="Trace"
        data-tip="Trace"
      >
        <IconTrace size={18} />
      </a>
      <a
        className={`rail-link${route === "#/observe/ops" ? " active" : ""}`}
        href="#/observe/ops"
        aria-label="Ops"
        data-tip="Ops"
      >
        <IconSliders size={18} />
      </a>
      <span className="rail-spacer" />
      <button
        type="button"
        className="rail-link"
        aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}
        data-tip={collapsed ? "展开侧边栏" : "折叠侧边栏"}
        onClick={onToggle}
      >
        <IconPanelLeft size={18} />
      </button>
    </nav>
  );
}
