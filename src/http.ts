import {
  APIConnectionError,
  APITimeoutError,
  Server4AgentError,
  errorFromStatus,
} from "./errors.js";
import { VERSION } from "./version.js";

export interface HttpConfig {
  baseUrl: string;
  apiKey: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
  /** How many times to retry a retryable failure (on top of the first attempt). */
  maxRetries: number;
  /** Injectable for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  method?: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Abort the request (and stop retries) from the caller side. */
  signal?: AbortSignal;
}

// Statuses worth retrying at all.
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// Methods safe to retry on any retryable status (no risk of a duplicate write).
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
// For POST/PATCH we only retry when the server clearly did not process the request.
const NON_IDEMPOTENT_RETRY_STATUS = new Set([408, 429, 503]);

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

const DEBUG =
  typeof process !== "undefined" && process.env?.SERVER4AGENT_LOG === "debug";
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.error("[server4agent]", ...args);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return undefined; // tolerate proxy HTML / non-JSON error pages
  }
}

function shouldRetryStatus(method: string, status: number, attempt: number, maxRetries: number): boolean {
  if (attempt >= maxRetries || !RETRYABLE_STATUS.has(status)) return false;
  if (IDEMPOTENT_METHODS.has(method)) return true;
  return NON_IDEMPOTENT_RETRY_STATUS.has(status);
}

function canRetryException(method: string, attempt: number, maxRetries: number): boolean {
  // A network/timeout error may have been processed server-side, so only retry
  // methods where a duplicate is harmless.
  return attempt < maxRetries && IDEMPOTENT_METHODS.has(method);
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, BACKOFF_MAX_MS);
  }
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
  return Math.random() * ceiling; // full jitter
}

export class Http {
  // True private (#) fields: never enumerable, so the API key can never leak
  // into `console.log(client)` or `JSON.stringify(client)`.
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #timeoutMs: number;
  readonly #maxRetries: number;
  readonly #fetch: typeof fetch;

  constructor(config: HttpConfig) {
    const impl = config.fetch ?? (typeof fetch !== "undefined" ? fetch : undefined);
    if (!impl) {
      throw new Server4AgentError(
        "global fetch is unavailable — use Node 18+ or pass a fetch implementation via { fetch }.",
      );
    }
    this.#baseUrl = config.baseUrl;
    this.#apiKey = config.apiKey;
    this.#timeoutMs = config.timeoutMs;
    this.#maxRetries = config.maxRetries;
    this.#fetch = impl;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const url = new URL(opts.path.replace(/^\//, ""), this.#baseUrl.replace(/\/?$/, "/"));
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const method = (opts.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      "User-Agent": `server4agent-js/${VERSION}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    for (let attempt = 0; ; attempt++) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new APIConnectionError("Request aborted.");

      const controller = new AbortController();
      const onUserAbort = () => controller.abort();
      opts.signal?.addEventListener("abort", onUserAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
      const started = Date.now();

      let res: Response;
      try {
        debugLog("-->", method, url.pathname);
        res = await this.#fetch(url, { method, headers, body: bodyStr, signal: controller.signal });
      } catch (err) {
        if (opts.signal?.aborted) throw err; // caller cancelled — never retry or wrap
        if (canRetryException(method, attempt, this.#maxRetries)) {
          await sleep(retryDelayMs(attempt, null));
          continue;
        }
        const timedOut = err instanceof Error && err.name === "AbortError";
        throw timedOut ? new APITimeoutError() : new APIConnectionError(String(err));
      } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", onUserAbort);
      }

      debugLog("<--", method, url.pathname, res.status, `(${Date.now() - started}ms)`);

      if (shouldRetryStatus(method, res.status, attempt, this.#maxRetries)) {
        const delay = retryDelayMs(attempt, res.headers.get("retry-after"));
        debugLog("...retrying in", `${Math.round(delay)}ms`, `(attempt ${attempt + 1})`);
        await sleep(delay);
        continue;
      }

      const text = await res.text();
      const data = text ? safeJsonParse(text) : undefined;

      if (!res.ok) {
        const code = (data && data.error) || "unknown_error";
        const message = (data && data.message) || `Request failed with status ${res.status}`;
        throw errorFromStatus(res.status, code, message, res.headers.get("x-request-id"));
      }

      return data as T;
    }
  }
}
