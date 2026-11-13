import { CookieJar } from "tough-cookie";
import { MileError, publicError } from "../errors.js";
import { API_ORIGIN, APP_ORIGIN, READ_ENDPOINTS } from "../mile/constants.js";
import type { SessionStore } from "./session.js";

export interface ApiTransport {
  send(path: string, body?: unknown, method?: "DELETE"): Promise<{ status: number; data: unknown }>;
  refresh(): Promise<void>;
  close(): Promise<void>;
}

export class HttpTransport implements ApiTransport {
  private refreshInFlight?: Promise<void>;
  private pending: Promise<unknown> = Promise.resolve();

  // Serialize reads and refreshes so an old response cannot overwrite rotated credentials.
  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }

  constructor(
    private readonly store: SessionStore,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async state() {
    // Read each time so a running MCP picks up an imported session immediately.
    const saved = await this.store.load();
    if (!saved) {
      throw new MileError(
        "LOGIN_REQUIRED",
        "저장된 마일 세션이 없습니다. import-session 명령으로 세션을 가져와 주세요.",
      );
    }
    try {
      return { token: saved.accessToken, jar: await CookieJar.deserialize(saved.cookieJar) };
    } catch {
      throw new MileError(
        "AUTH_FORMAT_CHANGED",
        "저장된 마일 쿠키를 읽지 못했습니다. import-session 명령으로 유효한 세션을 가져와 주세요.",
      );
    }
  }

  private async persist(state: { token: string; jar: CookieJar }) {
    await this.store.save({
      version: 1,
      accessToken: state.token,
      cookieJar: await state.jar.serialize(),
    });
  }

  private async request(
    path: string,
    body?: unknown,
    bearer = true,
    persistCookies = true,
    method?: "DELETE",
  ) {
    // Never follow redirects or forward credentials to a caller-supplied origin.
    const url = new URL(path, API_ORIGIN);
    if (url.origin !== API_ORIGIN || !path.startsWith("/") || path.startsWith("//")) {
      throw new MileError("ENDPOINT_NOT_ALLOWED", "마일 API 주소만 호출할 수 있습니다.");
    }
    const state = await this.state();
    const cookies = await state.jar.getCookieString(url.href);
    const requestMethod = method ?? (body === undefined ? "GET" : "POST");
    const started = performance.now();
    let status: number | undefined;
    let responseData: unknown;
    let errorCode: string | undefined;
    try {
      const response = await this.fetcher(url, {
        method: requestMethod,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          Origin: APP_ORIGIN,
          Referer: `${APP_ORIGIN}/`,
          ...(bearer ? { Authorization: `Bearer ${state.token}` } : {}),
          ...(cookies ? { Cookie: cookies } : {}),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      responseData = await response.json().catch(() => null);
      const updatedCookies = response.headers.getSetCookie();
      for (const cookie of updatedCookies) {
        await state.jar.setCookie(cookie, url.href);
      }
      if (bearer && persistCookies && updatedCookies.length) {
        await this.persist(state);
      }
      return {
        status: response.status,
        data: responseData,
        state,
      };
    } catch (error) {
      errorCode = publicError(error).code;
      throw error;
    } finally {
      if (READ_ENDPOINTS.has(path) && method === undefined) {
        console.error(
          JSON.stringify(
            {
              event: "mile_query",
              timestamp: new Date().toISOString(),
              method: requestMethod,
              path,
              params: body ?? {},
              durationMs: Math.round(performance.now() - started),
              success:
                errorCode === undefined && status !== undefined && status >= 200 && status < 300,
              ...(status === undefined ? {} : { httpStatus: status }),
              ...(errorCode ? { errorCode } : {}),
              ...(responseData === undefined ? {} : { response: responseData }),
            },
            (key, value: unknown) => {
              if (
                /^(authorization|proxyauthorization|accesstoken|refreshtoken|idtoken|token|cookies?|cookiejar|setcookie|password|clientsecret|apikey)$/i.test(
                  key.replace(/[-_]/g, ""),
                )
              ) {
                return "[REDACTED]";
              }
              if (typeof value !== "string") {
                return value;
              }
              return [state.token, cookies]
                .filter(Boolean)
                .reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
            },
          ),
        );
      }
    }
  }

  async send(path: string, body?: unknown, method?: "DELETE") {
    return this.exclusive(async () => {
      if (path === "/auth/member/my") {
        const response = await this.request(path, body, true, false);
        if (response.status >= 200 && response.status < 300) {
          await this.persistToken(response.state, response.data);
          return { status: response.status, data: { selected: true } };
        }
        return { status: response.status, data: response.data };
      }
      const { status, data } = await this.request(path, body, true, true, method);
      return { status, data };
    });
  }

  async refresh(): Promise<void> {
    this.refreshInFlight ??= this.exclusive(() => this.performRefresh()).finally(() => {
      this.refreshInFlight = undefined;
    });
    await this.refreshInFlight;
  }

  private async performRefresh() {
    const response = await this.request("/auth/silent-refresh", {}, false);
    if (response.status === 401 || response.status === 409) {
      throw new MileError(
        "LOGIN_REQUIRED",
        "마일 세션이 만료됐습니다. import-session 명령으로 유효한 세션을 가져와 주세요.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MileError(
        "API_ERROR",
        `마일 세션 갱신이 HTTP ${response.status} 오류를 반환했습니다.`,
      );
    }
    await this.persistToken(response.state, response.data);
  }

  private async persistToken(state: { token: string; jar: CookieJar }, value: unknown) {
    const data = value as { accessToken?: unknown } | null;
    if (typeof data?.accessToken !== "string" || !data.accessToken) {
      throw new MileError("AUTH_FORMAT_CHANGED", "마일 인증 응답 형식이 변경됐습니다.");
    }
    state.token = data.accessToken;
    await this.persist(state);
  }

  async close(): Promise<void> {
    await this.pending;
  }
}
