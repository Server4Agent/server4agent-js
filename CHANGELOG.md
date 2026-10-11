# Changelog

## 0.7.0

Every REST endpoint now has a method. Nothing that worked in 0.6.0 changes
meaning; the additions are new methods, new optional parameters, and fields
the API was already sending that the SDK used to drop.

New:

- Secrets: `client.secrets.list()`, `set({ key, value, description? })` and
  `delete(id)` for the account, plus `server.secrets` and `project.secrets`
  with `list()` and `set([...])`, which set each key and bind it to that
  scope (flat forms: `secrets.listForServer()`, `setForServer()`,
  `listForProject()`, `setForProject()`). Values are write-only: a `Secret`
  carries the key, a masked hint and where it is bound, never the value.
  `servers.create()` and `projects.create()` also take `secrets` inline.
- `project.start(command, { name? })`: run the app in the project's folder on
  its port and report whether it answered. An app that exits first fails with
  a `ConflictError` whose `body.log_tail` says why.
- `project.deploy()`: put the project online and resolve to `{ url, status,
  projectId }`, where `status` is `"live"` once the URL answered and
  `"publishing"` before.
- `server.logs({ projectId?, lines? })`, `project.logs()` and
  `servers.logs()`: the latest log-file tails, or null before the server has
  reported any. When the server cannot be reached the API answers with the
  last saved copy without saying so, so check `updatedAt`.
- `project.init({ proceed? })`: start bring-up for a project seeded from code,
  or resume one waiting on secrets.
- `project.export({ ttlSeconds? })` and `server.projects.import(bundle, {
  name? })`: move a project between deployments. `bundle` is bytes or a base64
  string; the result is the new `project` plus `missingEnv`, `boundEnv` and
  `warnings`.
- `client.tuning` (`list`, `start`, `get`, `report`) and a `TuningSession`
  handle whose `wait()` polls until the outcome is reported or failed, or the
  run behind it asks a question. Reading a session is what moves it along.
- `client.me()`: the account a key acts on, its spend against its budget, and
  whether new tasks are blocked.
- `projects.create()` takes `source` (git, archive, template or blank) and
  `autoInit`; `project.update()` takes `runPlan`.
- `tasks.create(goal, { projectId?, followUpOf? })` runs a task in a project's
  folder, or continues an earlier task's conversation, which is how to answer
  one that stopped at `awaiting_input`. `exec(command, { projectId? })` runs
  inside a project's folder.
- New fields on what the API already returned: `project.initPhase`,
  `project.source`, `project.runPlan`, `project.initRunId` (after a create or
  import), `task.projectId`, `task.log`, `task.change`, `task.usage`,
  `task.followUpOf` and `task.resumed` (after a follow-up), `deployment.projectId`,
  `template.sourceKind`, and `APIStatusError.body`, the whole error body.

Fixed:

- `projects.update()` now accepts `access`, which `project.update()` already
  did.
- `server.deploy()` takes `{ projectId }`. A server with more than one project
  could not be deployed at all, because the API asks which one.
- `BuildStepStatus` includes `"failed"`, which the API sends when a build's run
  fails.
- `WEBHOOK_EVENTS` matches what the API accepts: `quota.egress_cap_reached`,
  `tuning.started` and `tuning.completed` were missing, so subscribing to them
  did not typecheck.
- `examples/preview-env.ts` builds the branch in the project's own folder,
  starts the app with `project.start()` and puts it online with
  `project.deploy()`. It used to build at the server root, so the project URL
  it printed never had anything behind it.

## 0.6.0

- `server.kind` on every server handle: `"standard"` for a headless box,
  `"browser"` for one with a screen and a browser on it. The field was already
  set at creation but no read path returned it, so a browser server was
  indistinguishable from a headless one once you had it. A server from an API
  that predates the field reads as `"standard"`.
- `kind` is accepted by `servers.create()`, which is what provisions a browser
  box. It needs a plan that allows the medium tier, and costs more to run.
- `ServerKind` is exported alongside `ServerTier`. The two are orthogonal: a
  kind decides what is installed on the box, a tier decides how much of it you
  get and how many projects fit.

## 0.5.0

- Requires Node 22 or newer. Node 18 and 20 are both past end of life, so the
  floor now sits on the oldest release that still gets upstream fixes. The one
  code change is the error thrown when no global `fetch` exists, which now
  names the version it actually needs; everything else behaves as 0.4.0 did.

## 0.4.0

- `project.access` and the `access` option on `projects.create()` and
  `project.update()`. `"public"` is anyone with the link, which is what every
  project did before and stays the default. `"team"` puts the project's URL
  behind a Server4Agent sign-in, so only people in the account that owns it can
  open it. A project from an API that predates the field reads as `"public"`.
- `ProjectAccess` is exported alongside `ProjectVisibility`. The two are
  separate on purpose: `visibility` decides whether the URL serves at all,
  `access` decides who gets through once it does.

## 0.3.0

- `task.messageType`: `"user"` for a task you created, `"system"` for one the
  platform started for you (a project imported from git brings itself up this
  way). A system task's `goal` is a short summary of the run, not the
  instructions its agent was given. Tasks from an API that predates the field
  read as `"user"`.

## 0.2.0

- `files.getDownloadUrl(serverId, path, { ttlSeconds? })`: mint a signed,
  expiring link anyone can use to download one workspace file, no API key
  required to fetch it.
- `files.readBinary(serverId, path)` and `files.write(serverId, path, bytes)`:
  read/write binary files (e.g. a generated `.xlsx`) without corrupting
  bytes; `write` now also accepts a `Uint8Array`/`Buffer` alongside `string`.

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
