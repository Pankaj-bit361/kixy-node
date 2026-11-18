/** An error with an HTTP status. The API answers with `{ error, message }` and any extra fields. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }

  static badRequest(message: string): AppError {
    return new AppError(400, "bad_request", message);
  }
  static unauthorized(): AppError {
    return new AppError(401, "unauthorized", "sign in first");
  }
  static notFound(): AppError {
    return new AppError(404, "not_found", "not found");
  }
  static conflict(message: string): AppError {
    return new AppError(409, "conflict", message);
  }
  static noCredits(need: number, have: number): AppError {
    return new AppError(402, "no_credits", `this needs ${need} credits and you have ${have}`, { need, have });
  }
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
