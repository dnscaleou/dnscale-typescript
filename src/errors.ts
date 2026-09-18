export class APIError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly requestId: string | null,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "APIError";
  }
}

export class RateLimitError extends APIError {
  constructor(
    code: string, message: string, requestId: string | null,
    public readonly retryAfter: string | null, details?: unknown,
  ) {
    super(429, code, message, requestId, details);
    this.name = "RateLimitError";
  }
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

export async function responseError(response: Response): Promise<APIError> {
  let code = "HTTP_ERROR";
  let message = `DNScale returned HTTP ${response.status} without a valid API error envelope`;
  let details: unknown;
  try {
    const body: unknown = await response.json();
    if (body && typeof body === "object" && "error" in body) {
      const error = body.error;
      if (error && typeof error === "object") {
        if ("code" in error && typeof error.code === "string") code = error.code;
        if ("message" in error && typeof error.message === "string") message = error.message;
        if ("details" in error) details = error.details;
      }
    }
  } catch { /* Gateways can return HTML or an empty body. Preserve HTTP metadata. */ }
  const requestId = response.headers.get("X-Request-ID");
  return response.status === 429
    ? new RateLimitError(code, message, requestId, response.headers.get("Retry-After"), details)
    : new APIError(response.status, code, message, requestId, details);
}
