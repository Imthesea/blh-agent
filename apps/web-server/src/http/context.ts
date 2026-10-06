import type { SessionManager } from "../session.js";
import type { SSEBroadcaster } from "../bridge.js";
import type { SessionStoreModule, TraceModule } from "../types.js";

export interface WebContext {
  session: SessionManager;
  broadcaster: SSEBroadcaster;
  workdir: string;
  staticDir: string | null;
  sessionStore: SessionStoreModule;
  trace?: TraceModule;
}
