import { AsyncLocalStorage } from "node:async_hooks";

const scheduledTurnStorage = new AsyncLocalStorage<boolean>();

/** 在 scheduled-turn 上下文中执行回调；回调内申请交互审批会被拒绝。 */
export function runInScheduledTurn<T>(fn: () => Promise<T>): Promise<T> {
  return scheduledTurnStorage.run(true, fn);
}

export function isScheduledTurn(): boolean {
  return scheduledTurnStorage.getStore() === true;
}

/** dream 轮上下文：携带 workdir 与 memory 目录，用于写白名单判定。 */
export interface DreamContext {
  workdir: string;
  memoryDir: string;
}

const dreamTurnStorage = new AsyncLocalStorage<DreamContext>();

/** dream 轮上下文：叠加 scheduled 语义（禁交互审批）+ dream 写白名单。 */
export function runInDreamTurn<T>(ctx: DreamContext, fn: () => Promise<T>): Promise<T> {
  return runInScheduledTurn(() => dreamTurnStorage.run(ctx, fn));
}

export function getDreamTurnContext(): DreamContext | undefined {
  return dreamTurnStorage.getStore();
}
