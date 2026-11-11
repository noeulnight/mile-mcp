import { MileError, publicError } from "../errors.js";
import type { SessionStore } from "./session.js";
import type { ApiTransport } from "./transport.js";

function expiresAt(token: string): number | undefined {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
    );
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

export class SessionRefresher {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private stopped = true;
  private lastRefresh?: number;
  private blockedToken?: string;
  private lastError?: string;

  constructor(
    private readonly transport: Pick<ApiTransport, "refresh">,
    private readonly store: SessionStore,
    private readonly log: (message: object) => void = (message) =>
      console.error(JSON.stringify(message)),
  ) {}

  async check(): Promise<void> {
    let token: string | undefined;
    try {
      const session = await this.store.load();
      if (!session) {
        throw new MileError(
          "LOGIN_REQUIRED",
          "저장된 마일 세션이 없습니다. import-session 명령으로 세션을 가져와 주세요.",
        );
      }
      token = session.accessToken;
      if (this.blockedToken === token) {
        return;
      }
      const expiration = expiresAt(token);
      const due =
        expiration === undefined
          ? this.lastRefresh === undefined || Date.now() - this.lastRefresh >= 15 * 60_000
          : expiration - Date.now() <= 2 * 60_000;
      if (!due) {
        return;
      }
      await this.transport.refresh();
      this.lastRefresh = Date.now();
      this.blockedToken = undefined;
      this.lastError = undefined;
      this.log({ event: "session_refreshed" });
    } catch (error) {
      const exposed = publicError(error);
      if (exposed.code === "LOGIN_REQUIRED" || exposed.code === "AUTH_FORMAT_CHANGED") {
        this.blockedToken = token;
      }
      if (this.lastError !== exposed.code) {
        this.log({ event: "session_refresh_failed", ...exposed });
      }
      this.lastError = exposed.code;
    }
  }

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    const tick = () => {
      this.running = this.check().finally(() => {
        if (!this.stopped) {
          this.timer = setTimeout(tick, 60_000);
          this.timer.unref();
        }
      });
    };
    tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }
}
