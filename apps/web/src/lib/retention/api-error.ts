import { ApiError, extractErrorMessage } from "@/utils/api-errors";

function retentionErrorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    error.error &&
    typeof error.error === "object" &&
    "code" in error.error &&
    typeof error.error.code === "string"
  ) {
    return error.error.code;
  }
  return null;
}

export class RetentionApiError extends ApiError {
  readonly code: string | null;

  constructor(status: number, message: string, code: string | null) {
    super(status, message);
    this.name = "RetentionApiError";
    this.code = code;
  }
}

export function throwRetentionResponseError(
  response: Response,
  error: unknown,
  fallback: string,
): never {
  throw new RetentionApiError(
    response.status,
    extractErrorMessage(error, response, fallback),
    retentionErrorCode(error),
  );
}
