# Changelog

## 0.1.0

Initial release.

- Fully typed, promise-based `Server4Agent` client (ESM, Node 18+).
- Resource-oriented handles: `create()`/`get()` resolve to `Server`/`Project`/`Task`/`Build`
  objects with scoped sub-resources (`server.tasks`, `server.files`, ...) and actions
  (`server.exec()`, `server.deploy()`, `project.update()`). Internals are kept off the
  instance, so `console.log`/`JSON.stringify` show only data.
- `task.wait()` / `build.wait()` poll until a terminal state, with `onProgress` and
  `AbortSignal` support.
- Typed error hierarchy under `Server4AgentError` (`NotFoundError`, `RateLimitError`,
  `APIStatusError`, ...) exposing `status`, `code`, and `requestId`.
- Automatic retries with exponential backoff + jitter; retries are method-aware so a
  `POST` is never retried in a way that could double-create. Configurable `timeoutMs`
  and `maxRetries`.
- Webhook signature verification (`verifyWebhookSignature`).
- Opt-in request logging via `SERVER4AGENT_LOG=debug`.
