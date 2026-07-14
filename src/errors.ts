/** Base class for every error thrown by this SDK. */
export class Server4AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The request never reached the API (DNS, TCP, TLS, or a dropped connection). */
export class APIConnectionError extends Server4AgentError {
  constructor(message = "Could not reach the Server4Agent API.") {
    super(message);
  }
}

/** The request timed out before the API responded. */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request to the Server4Agent API timed out.") {
    super(message);
  }
}

/**
 * The API returned a 4xx/5xx response. Prefer catching a specific subclass
 * (`NotFoundError`, `RateLimitError`, ...). `code` is the machine-readable
 * string from the body; `requestId` (when present) is worth quoting to support.
 */
export class APIStatusError extends Server4AgentError {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/** 400 — the request was malformed. */
export class BadRequestError extends APIStatusError {}
/** 401 — the API key is missing, invalid, or revoked. */
export class AuthenticationError extends APIStatusError {}
/** 403 — the key is valid but not scoped to this resource. */
export class PermissionDeniedError extends APIStatusError {}
/** 404 — no such resource. */
export class NotFoundError extends APIStatusError {}
/** 409 — the request conflicts with current state (e.g. a cap was hit). */
export class ConflictError extends APIStatusError {}
/** 422 — well-formed but semantically invalid. */
export class UnprocessableEntityError extends APIStatusError {}
/** 429 — too many requests. The SDK retries these automatically. */
export class RateLimitError extends APIStatusError {}
/** 5xx — something went wrong on the API side. */
export class InternalServerError extends APIStatusError {}

const STATUS_TO_ERROR: Record<number, typeof APIStatusError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  422: UnprocessableEntityError,
  429: RateLimitError,
};

/** Map an HTTP status onto the most specific `APIStatusError` subclass. */
export function errorFromStatus(
  status: number,
  code: string,
  message: string,
  requestId: string | null = null,
): APIStatusError {
  const Cls = STATUS_TO_ERROR[status] ?? (status >= 500 ? InternalServerError : APIStatusError);
  return new Cls(status, code, message, requestId);
}
