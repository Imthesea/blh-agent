export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export const DISPOSE_PHASES = ["connections", "activity", "resources", "listener"] as const;

export type DisposePhase = (typeof DISPOSE_PHASES)[number];

export type ResourceKind =
  | "http-server"
  | "sse"
  | "session"
  | "background"
  | "cron"
  | "mcp"
  | "teammate"
  | "harness";

export interface DisposableResource {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly phase: DisposePhase;
  cancel(): void;
  dispose(deadline: ShutdownDeadline): Promise<void>;
  forceDispose(): void;
}

export interface ShutdownDeadline {
  readonly signal: AbortSignal;
  remainingMs(): number;
}

export interface DisposeFailure {
  readonly id: string;
  readonly kind: ResourceKind;
  readonly stage: "cancel" | "dispose" | "force";
  readonly error: string;
}

export interface DisposeReport {
  readonly timedOut: boolean;
  readonly completed: readonly string[];
  readonly failed: readonly DisposeFailure[];
}

export class LifecycleDisposeError extends Error {
  constructor(readonly report: DisposeReport) {
    super(formatReport(report));
    this.name = "LifecycleDisposeError";
  }
}

type LifecycleState = "active" | "cancelling" | "disposing" | "disposed";

export class LifecycleManager {
  private readonly resources = new Map<string, DisposableResource>();
  private readonly cancelFailures: DisposeFailure[] = [];
  private state: LifecycleState = "active";
  private disposePromise: Promise<void> | null = null;

  register<T extends DisposableResource>(resource: T): T {
    if (this.state !== "active") {
      throw new Error("cannot register a resource after lifecycle shutdown starts");
    }
    if (this.resources.has(resource.id)) {
      throw new Error(`lifecycle resource already registered: ${resource.id}`);
    }
    this.resources.set(resource.id, resource);
    return resource;
  }

  cancel(): void {
    if (this.state !== "active") return;
    this.state = "cancelling";
    for (const resource of [...this.resources.values()]) {
      try {
        resource.cancel();
      } catch (error) {
        this.cancelFailures.push({
          id: resource.id,
          kind: resource.kind,
          stage: "cancel",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async dispose(timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS): Promise<void> {
    if (this.disposePromise !== null) return this.disposePromise;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("shutdown timeout must be a non-negative integer");
    }

    this.disposePromise = this.runDispose(timeoutMs);
    return this.disposePromise;
  }

  private async runDispose(timeoutMs: number): Promise<void> {
    if (this.state === "active") this.cancel();
    this.state = "disposing";

    const deadline = createDeadline(timeoutMs);
    const resources = [...this.resources.values()].sort(
      (left, right) => phaseOrder(left.phase) - phaseOrder(right.phase),
    );
    const states = resources.map((resource) => ({ resource, done: false, settled: false }));
    const completed: string[] = [];
    const failed: DisposeFailure[] = [...this.cancelFailures];

    let timedOut = false;
    for (const phase of DISPOSE_PHASES) {
      const operations = states
        .filter((state) => state.resource.phase === phase)
        .map(async (state) => {
          try {
            await state.resource.dispose(deadline);
            state.done = true;
            completed.push(state.resource.id);
          } catch (error) {
            failed.push({
              id: state.resource.id,
              kind: state.resource.kind,
              stage: "dispose",
              error: error instanceof Error ? error.message : String(error),
            });
          } finally {
            state.settled = true;
          }
        });

      await Promise.race([Promise.all(operations), deadline.expired]);
      if (deadline.signal.aborted) {
        timedOut = states.some((state) => !state.settled);
        break;
      }
    }

    for (const state of states) {
      if (state.settled) continue;
      try {
        state.resource.forceDispose();
      } catch (error) {
        failed.push({
          id: state.resource.id,
          kind: state.resource.kind,
          stage: "force",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.state = "disposed";
    if (timedOut) {
      failed.push({
        id: "lifecycle",
        kind: "harness",
        stage: "dispose",
        error: `shutdown deadline exceeded after ${timeoutMs}ms`,
      });
    }

    if (failed.length > 0) {
      throw new LifecycleDisposeError({
        timedOut,
        completed,
        failed,
      });
    }
  }
}

function phaseOrder(phase: DisposePhase): number {
  return DISPOSE_PHASES.indexOf(phase);
}

function createDeadline(timeoutMs: number): ShutdownDeadline & { expired: Promise<void> } {
  const controller = new AbortController();
  const expiresAt = Date.now() + timeoutMs;
  let resolveExpired: (() => void) | undefined;
  const expired = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });
  const timer = setTimeout(() => {
    controller.abort(new Error(`shutdown deadline exceeded after ${timeoutMs}ms`));
    resolveExpired?.();
  }, timeoutMs);
  timer.unref();
  return {
    signal: controller.signal,
    remainingMs: () => Math.max(0, expiresAt - Date.now()),
    expired,
  };
}

function formatReport(report: DisposeReport): string {
  const parts = report.failed.map(
    (failure) => `${failure.stage} ${failure.kind}:${failure.id} failed: ${failure.error}`,
  );
  return `lifecycle dispose failed: ${parts.join("; ")}`;
}
