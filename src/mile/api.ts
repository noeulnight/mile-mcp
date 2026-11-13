import type { ApiTransport } from "../auth/transport.js";
import { MileError } from "../errors.js";

const READ_ENDPOINTS = new Set([
  "/users/info",
  "/users/member/list",
  "/members/my/info",
  "/members",
  "/meetings/recurring-reservation/check-duplication",
  "/meetings/meeting-room/list",
  "/meetings/meeting-reservation/list",
  "/meetings/meeting-reservation/detail",
  "/meetings/meeting-reservation/my/upcoming",
  "/meetings/meeting-reservation/my/completed",
]);

export class MileApi {
  constructor(private readonly transport: ApiTransport) {}

  async read(path: string, body?: unknown): Promise<unknown> {
    if (!READ_ENDPOINTS.has(path)) {
      throw new MileError("ENDPOINT_NOT_ALLOWED", "지정된 조회 API만 호출할 수 있습니다.");
    }
    let response = await this.transport.send(path, body);
    if (response.status === 401) {
      await this.transport.refresh();
      response = await this.transport.send(path, body);
    }
    if (response.status === 401) {
      throw new MileError(
        "LOGIN_REQUIRED",
        "워크스페이스 인증이 완료된 유효한 세션을 가져와 주세요.",
      );
    }
    if (response.status === 403) {
      throw new MileError("PERMISSION_DENIED", "현재 마일 계정으로 요청할 권한이 없습니다.");
    }
    if (response.status === 429) {
      throw new MileError(
        "RATE_LIMITED",
        "마일 요청 한도를 초과했습니다. 잠시 후 다시 요청해 주세요.",
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MileError("API_ERROR", `마일 API가 HTTP ${response.status} 오류를 반환했습니다.`);
    }
    if (response.data === null) {
      throw new MileError("API_FORMAT_CHANGED", "마일 API 응답 형식이 변경됐습니다.");
    }
    return response.data;
  }

  async selectWorkspace(member: unknown): Promise<void> {
    const uncertain = () =>
      new MileError(
        "WORKSPACE_SELECTION_UNKNOWN",
        "워크스페이스 전환 결과를 확인할 수 없습니다. 자동 재시도하지 말고 인증 상태를 확인해 주세요.",
      );
    let response: Awaited<ReturnType<ApiTransport["send"]>>;
    try {
      // Selection issues credentials, so never replay the request automatically.
      response = await this.transport.send("/auth/member/my", member);
    } catch (error) {
      if (error instanceof MileError && error.code === "LOGIN_REQUIRED") {
        throw error;
      }
      throw uncertain();
    }
    if (response.status === 401) {
      throw new MileError("LOGIN_REQUIRED", "세션을 갱신한 뒤 워크스페이스를 다시 선택해 주세요.");
    }
    if (response.status === 403 || response.status === 404) {
      throw new MileError("WORKSPACE_NOT_AVAILABLE", "참여 중인 워크스페이스인지 확인해 주세요.");
    }
    if (response.status === 429) {
      throw new MileError("RATE_LIMITED", "요청 한도를 초과했습니다. 잠시 후 다시 선택해 주세요.");
    }
    if (response.status < 200 || response.status >= 300) {
      throw uncertain();
    }
  }

  async cancelReservation(body: unknown): Promise<void> {
    const uncertain = () =>
      new MileError(
        "CANCELLATION_OUTCOME_UNKNOWN",
        "예약 취소 결과를 확인할 수 없습니다. 자동 재시도하지 말고 예약 목록과 상세에서 취소 여부를 먼저 확인해 주세요.",
      );
    let response: Awaited<ReturnType<ApiTransport["send"]>>;
    try {
      response = await this.transport.send("/meetings/meeting-reservation", body, "DELETE");
    } catch (error) {
      if (
        error instanceof MileError &&
        ["LOGIN_REQUIRED", "AUTH_FORMAT_CHANGED"].includes(error.code)
      ) {
        throw error;
      }
      throw uncertain();
    }
    // Never replay cancellation: the selected occurrence or series may already be gone.
    if (response.status === 401) {
      throw new MileError("LOGIN_REQUIRED", "인증을 갱신한 뒤 예약의 취소 여부를 확인해 주세요.");
    }
    if (response.status === 403) {
      throw new MileError("PERMISSION_DENIED", "현재 마일 계정으로 예약을 취소할 권한이 없습니다.");
    }
    if (response.status === 404) {
      throw new MileError(
        "RESERVATION_NOT_FOUND",
        "예약을 찾을 수 없습니다. 이미 취소됐는지 확인해 주세요.",
      );
    }
    if (response.status === 429) {
      throw new MileError(
        "RATE_LIMITED",
        "마일 요청 한도를 초과했습니다. 잠시 후 취소 여부를 확인해 주세요.",
      );
    }
    if (response.status >= 500) {
      throw uncertain();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MileError(
        "API_ERROR",
        `마일 취소 API가 HTTP ${response.status} 오류를 반환했습니다.`,
      );
    }
    const data = response.data as { result?: unknown } | null;
    if (!data || data.result === undefined || data.result === null || data.result === false) {
      throw uncertain();
    }
  }

  async createReservation(body: unknown): Promise<unknown> {
    const uncertain = () =>
      new MileError(
        "RESERVATION_OUTCOME_UNKNOWN",
        "예약 처리 결과를 확인할 수 없습니다. 자동 재시도하지 말고 내 예약 목록에서 생성 여부를 먼저 확인해 주세요.",
      );
    let response: Awaited<ReturnType<ApiTransport["send"]>>;
    try {
      response = await this.transport.send("/meetings/meeting-reservation", body);
    } catch (error) {
      // Local authentication failures happen before any request is sent.
      if (
        error instanceof MileError &&
        ["LOGIN_REQUIRED", "AUTH_FORMAT_CHANGED"].includes(error.code)
      ) {
        throw error;
      }
      throw uncertain();
    }
    // Never replay writes, including after a 401 or an ambiguous server error.
    if (response.status === 401) {
      throw new MileError(
        "LOGIN_REQUIRED",
        "세션이 만료됐습니다. 인증을 갱신한 뒤 예약 목록을 확인해 주세요.",
      );
    }
    if (response.status === 403) {
      throw new MileError("PERMISSION_DENIED", "현재 마일 계정으로 예약할 권한이 없습니다.");
    }
    if (response.status === 409) {
      throw new MileError(
        "RESERVATION_CONFLICT",
        "해당 시간은 이미 예약됐습니다. 다른 시간을 선택해 주세요.",
      );
    }
    if (response.status === 429) {
      throw new MileError(
        "RATE_LIMITED",
        "마일 요청 한도를 초과했습니다. 잠시 후 예약 목록을 확인해 주세요.",
      );
    }
    if (response.status >= 500) {
      throw uncertain();
    }
    if (response.status < 200 || response.status >= 300) {
      throw new MileError(
        "API_ERROR",
        `마일 예약 API가 HTTP ${response.status} 오류를 반환했습니다.`,
      );
    }
    const data = response.data as { result?: unknown } | null;
    if (!data || data.result === undefined || data.result === null || data.result === false) {
      throw uncertain();
    }
    return data.result;
  }
}
