export class GoalError extends Error {}

export interface GoalState {
  condition: string;
  iterations: number;
  setAt: number; // 秒
  tokensAtStart: number;
  lastReason?: string;
}

export interface GoalEvaluation {
  ok: boolean;
  reason: string;
  impossible: boolean;
}
