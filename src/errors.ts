export class MileError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MileError";
  }
}

export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof MileError) {
    return { code: error.code, message: error.message };
  }
  // HTTP exceptions may contain headers, cookies or request URLs.
  return {
    code: "UNEXPECTED_ERROR",
    message: "요청을 처리하지 못했습니다. 네트워크와 마일 로그인 상태를 확인해 주세요.",
  };
}
