import { Http } from "./http.js";
import { APITimeoutError, Server4AgentError } from "./errors.js";
import {
  type AccountSummary,
  type ApiKey,
  type BuildStep,
  type BuildStatus,
  BUILD_TERMINAL_STATES,
  type CreateProjectOptions,
  type CreatedApiKey,
  type CreatedWebhook,
  type Deployment,
  type DeployResult,
  type DeployStatus,
  type LogsSnapshot,
  type ProjectExport,
  type ProjectInitPhase,
  type ProjectInitResult,
  type ProjectLifecycle,
  type ProjectRuntimeStatus,
  type ProjectSource,
  type ProjectSourceKind,
  type ProjectTemplate,
  type ProjectAccess,
  type ProjectVisibility,
  type RunPlan,
  type Secret,
  type SecretInput,
  type Server4AgentOptions,
  type ServerAction,
  type ServerKind,
  type ServerStatus,
  type ServerTier,
  type StartAppResult,
  type StartTuningOptions,
  type TaskChange,
  type TaskMessageType,
  type TaskStatus,
  TASK_TERMINAL_STATES,
  type TaskUsage,
  type TuningBuild,
  type TuningReport,
  type TuningStatus,
  TUNING_TERMINAL_STATES,
  type UpdateProjectOptions,
  type Webhook,
  type WebhookEvent,
} from "./types.js";

const DEFAULT_BASE_URL = "https://api.server4agent.com";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Percent-encode a value for safe use as a single URL path segment, so an id
 *  containing "/", "..", "?", or "#" can't redirect the request elsewhere. */
function seg(value: string): string {
  return encodeURIComponent(value);
}

// --- raw wire shapes ---------------------------------------------------------

interface ServerRaw {
  id: string;
  task?: string;
  tier: ServerTier;
  /** Absent on an older control plane, which only ever built headless boxes. */
  kind?: ServerKind;
  status: ServerStatus;
  region?: string;
  creditsUsed?: number;
  storageUsedGb?: number;
  publicUrl?: string | null;
  createdAt?: string | null;
}

interface ProjectRaw {
  id: string;
  server_id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: ProjectVisibility;
  /** Absent on an older control plane, which only served open URLs. */
  access?: ProjectAccess;
  lifecycle: ProjectLifecycle;
  runtime_status: ProjectRuntimeStatus;
  /** Absent on an older control plane, which had no bring-up to report. */
  init_phase?: ProjectInitPhase | null;
  /** Absent on an older control plane, and null for a project created before sources. */
  source?: SourceRaw | null;
  run_plan?: RunPlan | null;
  /** Only in the answer to a create or an import. */
  init_run_id?: string | null;
  template: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

interface SourceRaw {
  kind: ProjectSourceKind;
  template?: string;
  git_url?: string;
  ref?: string;
  subdir?: string;
  auth_secret?: string;
  archive_path?: string;
  source_project_id?: string;
  origin?: string;
}

function toSource(r: SourceRaw): ProjectSource {
  const out: ProjectSource = { kind: r.kind };
  if (r.template !== undefined) out.template = r.template;
  if (r.git_url !== undefined) out.gitUrl = r.git_url;
  if (r.ref !== undefined) out.ref = r.ref;
  if (r.subdir !== undefined) out.subdir = r.subdir;
  if (r.auth_secret !== undefined) out.authSecret = r.auth_secret;
  if (r.archive_path !== undefined) out.archivePath = r.archive_path;
  if (r.source_project_id !== undefined) out.sourceProjectId = r.source_project_id;
  if (r.origin !== undefined) out.origin = r.origin;
  return out;
}

function createProjectBody(o: CreateProjectOptions) {
  const { source, autoInit, ...rest } = o;
  let wireSource: Record<string, unknown> | undefined;
  if (source) {
    switch (source.kind) {
      case "git":
        wireSource = {
          kind: "git",
          git_url: source.gitUrl,
          ref: source.ref,
          subdir: source.subdir,
          auth_secret: source.authSecret,
        };
        break;
      case "archive":
        wireSource = { kind: "archive", archive_path: source.archivePath };
        break;
      default:
        wireSource = { ...source };
    }
  }
  return { ...rest, source: wireSource, auto_init: autoInit };
}

function updateProjectBody(o: UpdateProjectOptions) {
  const { runPlan, ...rest } = o;
  return { ...rest, run_plan: runPlan };
}

/** What an import adds to the project it created. */
interface ImportedProjectRaw extends ProjectRaw {
  init_run_id?: string | null;
  imported_from?: string | null;
  exported_at: string;
  bound_env?: string[];
  missing_env?: string[];
  warnings?: string[];
}

interface TaskRaw {
  id: string;
  serverId: string;
  /** Absent on an older control plane, where every task ran at the server root. */
  projectId?: string | null;
  goal: string;
  messageType?: TaskMessageType;
  status: TaskStatus;
  createdAt: string;
  result?: string;
  question?: string;
  log?: string;
  change?: TaskChange;
  usage?: TaskUsage;
}

interface BuildRaw {
  id: string;
  serverId: string;
  goal: string;
  status: BuildStatus;
  steps?: BuildStep[];
  artifacts?: string[];
  url?: string | null;
  createdAt: string;
}

interface ApiKeyRaw {
  id: string;
  label: string;
  masked: string;
  allowed_server_ids: string[];
  allowed_project_ids: string[];
  created_at: string;
  last_used_at: string | null;
}

interface WebhookRaw {
  id: string;
  url: string;
  events: WebhookEvent[];
  created_at: string;
}

interface TuningSessionRaw {
  id: string;
  serverId: string;
  projectId: string;
  runId?: string | null;
  buildRunId?: string | null;
  proposalId: string;
  evaluationApiBase: string;
  keySecretKey: string;
  briefPath?: string | null;
  briefRevision?: string | null;
  status: TuningStatus;
  changeSummary?: string | null;
  changedFiles?: string[];
  deploymentUrl?: string | null;
  reportedAt?: string | null;
  reportError?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The agent run behind a tuning session, in the snake_case shape that endpoint returns. */
interface RunRaw {
  run_id: string;
  server_id: string;
  project_id?: string | null;
  goal: string;
  message_type?: TaskMessageType;
  status: TaskStatus;
  created_at: string;
  log?: string | null;
  result?: string | null;
  question?: string | null;
  change?: {
    commit: string;
    branch?: string | null;
    merge_commit?: string | null;
    files_changed: number;
    insertions: number;
    deletions: number;
    files: string[];
  } | null;
  usage?: {
    cost_usd: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    turns: number;
    duration_ms: number;
    cost_source?: TaskUsage["costSource"] | null;
  } | null;
}

function runToTask(r: RunRaw): TaskRaw {
  const c = r.change;
  const u = r.usage;
  return {
    id: r.run_id,
    serverId: r.server_id,
    projectId: r.project_id ?? null,
    goal: r.goal,
    messageType: r.message_type,
    status: r.status,
    createdAt: r.created_at,
    result: r.result ?? undefined,
    question: r.question ?? undefined,
    log: r.log ?? undefined,
    change: c
      ? {
          commit: c.commit,
          ...(c.branch ? { branch: c.branch } : {}),
          ...(c.merge_commit ? { mergeCommit: c.merge_commit } : {}),
          filesChanged: c.files_changed,
          insertions: c.insertions,
          deletions: c.deletions,
          files: c.files,
        }
      : undefined,
    usage: u
      ? {
          cost: u.cost_usd,
          inputTokens: u.input_tokens,
          outputTokens: u.output_tokens,
          cacheReadTokens: u.cache_read_tokens,
          cacheWriteTokens: u.cache_write_tokens,
          turns: u.turns,
          durationMs: u.duration_ms,
          ...(u.cost_source ? { costSource: u.cost_source } : {}),
        }
      : undefined,
  };
}

interface DeploymentRaw {
  url: string;
  live: boolean;
  /** Absent on an older control plane, which listed the server's own address. */
  project_id?: string;
}

interface SecretRaw {
  id: string;
  key: string;
  description: string | null;
  masked?: string | null;
  server_ids?: string[];
  project_ids?: string[];
  created_at: string;
  updated_at: string;
}

function toApiKey(r: ApiKeyRaw): ApiKey {
  return {
    id: r.id,
    label: r.label,
    masked: r.masked,
    allowedServerIds: r.allowed_server_ids,
    allowedProjectIds: r.allowed_project_ids,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

function toWebhook(r: WebhookRaw): Webhook {
  return { id: r.id, url: r.url, events: r.events, createdAt: r.created_at };
}

function toDeployment(r: DeploymentRaw): Deployment {
  return { url: r.url, live: r.live, projectId: r.project_id ?? null };
}

function toSecret(r: SecretRaw): Secret {
  return {
    id: r.id,
    key: r.key,
    description: r.description ?? null,
    masked: r.masked ?? "",
    serverIds: r.server_ids ?? [],
    projectIds: r.project_ids ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// --- requests shared by a handle and its flat twin ---------------------------
// Deploys, logs, app starts, init and export are reachable from more than one
// place (a server, a project, the flat client), so each lives here once.

async function requestDeploy(http: Http, serverId: string, projectId?: string): Promise<DeployResult> {
  const r = await http.request<{ url: string; status: DeployStatus; project_id: string }>({
    method: "POST",
    path: `/servers/${seg(serverId)}/deployments`,
    body: { project_id: projectId },
  });
  return { url: r.url, status: r.status, projectId: r.project_id };
}

async function requestStart(
  http: Http,
  projectId: string,
  command: string,
  opts: { name?: string },
): Promise<StartAppResult> {
  const r = await http.request<{
    project_id: string;
    name: string;
    status: StartAppResult["status"];
    listening: boolean;
    listen_port?: number | null;
    url?: string | null;
    visibility: ProjectVisibility;
    access?: ProjectAccess;
    replaced_previous?: boolean;
    restart_command: string;
    log_tail?: string | null;
  }>({
    method: "POST",
    path: `/projects/${seg(projectId)}/start`,
    body: { command, name: opts.name },
  });
  return {
    projectId: r.project_id,
    name: r.name,
    status: r.status,
    listening: r.listening,
    listenPort: r.listen_port ?? null,
    url: r.url ?? null,
    visibility: r.visibility,
    access: r.access ?? "public",
    replacedPrevious: r.replaced_previous ?? false,
    restartCommand: r.restart_command,
    logTail: r.log_tail ?? null,
  };
}

async function requestDeployments(http: Http, serverId: string): Promise<Deployment[]> {
  const r = await http.request<{ deployments: DeploymentRaw[] }>({
    path: `/servers/${seg(serverId)}/deployments`,
  });
  return r.deployments.map(toDeployment);
}

async function requestLogs(
  http: Http,
  serverId: string,
  opts: { projectId?: string; lines?: number },
): Promise<LogsSnapshot | null> {
  const r = await http.request<{ logs: LogsSnapshot | null }>({
    path: `/servers/${seg(serverId)}/logs`,
    query: {
      project_id: opts.projectId,
      lines: opts.lines != null ? String(opts.lines) : undefined,
    },
  });
  return r.logs ?? null;
}

async function requestInit(
  http: Http,
  projectId: string,
  opts: { proceed?: boolean },
): Promise<ProjectInitResult> {
  const r = await http.request<{ init_run_id?: string | null; init_phase?: ProjectInitPhase | null }>({
    method: "POST",
    path: `/projects/${seg(projectId)}/init`,
    body: { proceed: opts.proceed },
  });
  return { initRunId: r.init_run_id ?? null, initPhase: r.init_phase ?? null };
}

async function requestExport(
  http: Http,
  projectId: string,
  opts: { ttlSeconds?: number },
): Promise<ProjectExport> {
  const r = await http.request<{
    project_id?: string;
    url: string;
    expires_at: string;
    filename: string;
    bytes: number;
    env?: string[];
  }>({
    method: "POST",
    path: `/projects/${seg(projectId)}/export`,
    body: { ttl_seconds: opts.ttlSeconds },
  });
  return {
    projectId: r.project_id ?? projectId,
    url: r.url,
    expiresAt: r.expires_at,
    filename: r.filename,
    bytes: r.bytes,
    env: r.env ?? [],
  };
}

// =============================================================================
// Handles: returned by create()/get(); data records you can also act on.
// =============================================================================

/**
 * Base for handles. Keeps the transport off the instance as a non-enumerable
 * field so `console.log(server)` and `JSON.stringify(server)` show only the data
 * fields, never SDK internals.
 */
class Handle {
  protected declare readonly http: Http;
  constructor(http: Http) {
    Object.defineProperty(this, "http", { value: http, enumerable: false });
  }
}

/**
 * A compute server. Its sub-resources (`.tasks`, `.builds`, `.files`,
 * `.projects`, `.secrets`) are scoped to it.
 */
export class Server extends Handle {
  id!: string;
  task!: string;
  tier!: ServerTier;
  kind!: ServerKind;
  status!: ServerStatus;
  region!: string;
  creditsUsed!: number;
  storageUsedGb!: number;
  publicUrl!: string | null;
  createdAt!: string | null;

  constructor(http: Http, raw: ServerRaw) {
    super(http);
    this.assign(raw);
  }

  private assign(r: ServerRaw): void {
    this.id = r.id;
    this.task = r.task ?? "";
    this.tier = r.tier;
    this.kind = r.kind ?? "standard";
    this.status = r.status;
    this.region = r.region ?? "";
    this.creditsUsed = r.creditsUsed ?? 0;
    this.storageUsedGb = r.storageUsedGb ?? 0;
    this.publicUrl = r.publicUrl ?? null;
    this.createdAt = r.createdAt ?? null;
  }

  get projects(): ScopedProjects {
    return new ScopedProjects(this.http, this.id);
  }
  get tasks(): ScopedTasks {
    return new ScopedTasks(this.http, this.id);
  }
  get builds(): ScopedBuilds {
    return new ScopedBuilds(this.http, this.id);
  }
  get files(): ScopedFiles {
    return new ScopedFiles(this.http, this.id);
  }
  /**
   * Secrets bound server-wide, which every project on this server sees.
   * `set()` creates or updates each key and binds it here.
   */
  get secrets(): ScopedSecrets {
    return new ScopedSecrets(this.http, `/servers/${seg(this.id)}/secrets`);
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<{ server: ServerRaw }>({ path: `/servers/${seg(this.id)}` });
    this.assign(r.server);
    return this;
  }

  async update(patch: { task?: string; region?: string }): Promise<this> {
    const r = await this.http.request<{ server: ServerRaw }>({
      method: "PATCH",
      path: `/servers/${seg(this.id)}`,
      body: patch,
    });
    this.assign(r.server);
    return this;
  }

  async delete(): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/servers/${seg(this.id)}` });
  }

  control(action: ServerAction): Promise<{ id: string; status: ServerStatus }> {
    return this.http.request({ method: "POST", path: `/servers/${seg(this.id)}/actions`, body: { action } });
  }
  start(): Promise<{ id: string; status: ServerStatus }> {
    return this.control("start");
  }
  stop(): Promise<{ id: string; status: ServerStatus }> {
    return this.control("stop");
  }
  restart(): Promise<{ id: string; status: ServerStatus }> {
    return this.control("restart");
  }

  /**
   * Run a shell command on the server; resolves to stdout. Runs at the
   * workspace root, or inside a project's folder when `projectId` is given.
   */
  async exec(command: string, opts: { projectId?: string } = {}): Promise<string> {
    const r = await this.http.request<{ stdout: string }>({
      method: "POST",
      path: `/servers/${seg(this.id)}/exec`,
      body: { command, project_id: opts.projectId },
    });
    return r.stdout;
  }

  /**
   * Put a running project online; resolves to its public URL. Checks that
   * something in the project is listening on its port, makes it public, and
   * waits briefly for the URL to answer. It builds and starts nothing, so it
   * fails with a `ConflictError` when nothing is listening. `projectId` may be
   * left out when the server has exactly one project. `project.deploy()` also
   * says whether the URL answered yet.
   */
  async deploy(opts: { projectId?: string } = {}): Promise<string> {
    return (await requestDeploy(this.http, this.id, opts.projectId)).url;
  }

  /** The server's public projects and their addresses. */
  deployments(): Promise<Deployment[]> {
    return requestDeployments(this.http, this.id);
  }

  /**
   * The latest log-file tails from the server's background processes, or
   * null when it has not reported any yet. `projectId` narrows to one
   * project's files; `lines` caps each tail (1 to 1000, default 200).
   */
  logs(opts: { projectId?: string; lines?: number } = {}): Promise<LogsSnapshot | null> {
    return requestLogs(this.http, this.id, opts);
  }
}

/** A workspace + app inside a server. Its `.secrets` are scoped to it. */
export class Project extends Handle {
  id!: string;
  serverId!: string;
  name!: string;
  slug!: string;
  description!: string | null;
  visibility!: ProjectVisibility;
  /** Who may open the URL: anyone with the link, or only your team. */
  access!: ProjectAccess;
  lifecycle!: ProjectLifecycle;
  runtimeStatus!: ProjectRuntimeStatus;
  /**
   * How far bring-up has got for a project seeded from code, or null for one
   * that has none in progress (a blank project, or an API that predates it).
   */
  initPhase!: ProjectInitPhase | null;
  /** Where the workspace was seeded from. Null for a project created before sources existed. */
  source!: ProjectSource | null;
  /** How bring-up installs and starts the project, or null until a plan is settled. */
  runPlan!: RunPlan | null;
  /**
   * The bring-up run that `create()` or an import started, as a task id on
   * the project's server. Null otherwise, including on handles from `get()`
   * and `list()`.
   */
  initRunId: string | null = null;
  template!: string | null;
  /** Live URL, or null while the project is private. */
  url!: string | null;
  createdAt!: string;
  updatedAt!: string;

  constructor(http: Http, raw: ProjectRaw) {
    super(http);
    this.assign(raw);
  }

  private assign(r: ProjectRaw): void {
    this.id = r.id;
    this.serverId = r.server_id;
    this.name = r.name;
    this.slug = r.slug;
    this.description = r.description;
    this.visibility = r.visibility;
    this.access = r.access ?? "public";
    this.lifecycle = r.lifecycle;
    this.runtimeStatus = r.runtime_status;
    this.initPhase = r.init_phase ?? null;
    this.source = r.source ? toSource(r.source) : null;
    this.runPlan = r.run_plan ?? null;
    if (r.init_run_id !== undefined) this.initRunId = r.init_run_id ?? null;
    this.template = r.template;
    this.url = r.url;
    this.createdAt = r.created_at;
    this.updatedAt = r.updated_at;
  }

  /**
   * Secrets this project sees: its own plus the server-wide ones on its
   * server. `set()` creates or updates each key and binds it to this project
   * alone.
   */
  get secrets(): ScopedSecrets {
    return new ScopedSecrets(this.http, `/projects/${seg(this.id)}/secrets`);
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<ProjectRaw>({ path: `/projects/${seg(this.id)}` });
    this.assign(r);
    return this;
  }

  async update(patch: UpdateProjectOptions): Promise<this> {
    const r = await this.http.request<ProjectRaw>({
      method: "PATCH",
      path: `/projects/${seg(this.id)}`,
      body: updateProjectBody(patch),
    });
    this.assign(r);
    return this;
  }

  async delete(): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/projects/${seg(this.id)}` });
  }

  /** Ephemeral projects only. Use `delete()` for persistent ones. */
  async cleanup(): Promise<void> {
    await this.http.request({ method: "POST", path: `/projects/${seg(this.id)}/cleanup` });
  }

  /**
   * Run `command` in the project's folder as a background process on the
   * project's port, record it so a server restart brings it back, and report
   * whether it answered. `name` defaults to "web", the process that serves
   * the URL; give a worker or a scheduler its own name. An app that exits
   * before it answers fails with a `ConflictError` whose `body.log_tail` says
   * why. Then `deploy()` to put it online.
   */
  start(command: string, opts: { name?: string } = {}): Promise<StartAppResult> {
    return requestStart(this.http, this.id, command, opts);
  }

  /**
   * Put this project online once something in it is listening on its port
   * (see `Server.deploy()`), and say whether its URL answered yet. The handle
   * is not changed: `refresh()` to read the new visibility and URL.
   */
  deploy(): Promise<DeployResult> {
    return requestDeploy(this.http, this.serverId, this.id);
  }

  /** This project's log-file tails. See `Server.logs()`. */
  logs(opts: { lines?: number } = {}): Promise<LogsSnapshot | null> {
    return requestLogs(this.http, this.serverId, { projectId: this.id, lines: opts.lines });
  }

  /**
   * Start bring-up for a project seeded from code that was not brought up on
   * create, or resume one paused at "awaiting_secrets". `proceed: true` goes
   * on without secrets that are still unset instead of waiting for them.
   * Follow the run with `client.tasks.get(project.serverId, initRunId)`, or
   * `refresh()` and read `initPhase`.
   */
  init(opts: { proceed?: boolean } = {}): Promise<ProjectInitResult> {
    return requestInit(this.http, this.id, opts);
  }

  /**
   * Package this project into one portable file and mint a time-limited link
   * to it (default 24 hours, at most 7 days). The bundle carries the source,
   * settings, run plan, and the names of the environment variables it reads,
   * never their values. Feed it to `server.projects.import()` here or on
   * another deployment.
   */
  export(opts: { ttlSeconds?: number } = {}): Promise<ProjectExport> {
    return requestExport(this.http, this.id, opts);
  }
}

/** A project recreated from an export bundle, and what the import could not carry over. */
export interface ImportedProject {
  /** The new project. It lands private with its own slug, whatever the original was. */
  project: Project;
  /** The bring-up run that unpacks the bundle and starts the app, a task on the server. */
  initRunId: string | null;
  /** The deployment the bundle was exported from, as its manifest recorded it. */
  importedFrom: string | null;
  /** When the bundle was built. */
  exportedAt: string;
  /** Variables the bundle named that this account already had a value for, now bound to the project. */
  boundEnv: string[];
  /**
   * Variables the bundle named that still need a value here before the app
   * can run. Set them with `project.secrets.set()`.
   */
  missingEnv: string[];
  /**
   * Things the bundle asked for that this deployment could not honour. Not
   * failures: the import worked, and each would otherwise only show up later
   * as behaviour nobody can explain.
   */
  warnings: string[];
}

interface WaitOptions<T> {
  /** Milliseconds between polls. Default 2000. */
  pollIntervalMs?: number;
  /** Give up after this many milliseconds. Default 300000 (tasks), 600000 (builds), 1800000 (tuning). */
  timeoutMs?: number;
  /** Called with the handle after each poll, to stream progress to a log or UI. */
  onProgress?: (self: T) => void;
  /** Stop waiting when this signal aborts. */
  signal?: AbortSignal;
}

/** An agent goal running on a server. */
export class Task extends Handle {
  id!: string;
  serverId!: string;
  /** The project the task runs in, or null when it runs at the server workspace root. */
  projectId!: string | null;
  /**
   * What the task is doing. Yours verbatim; for a `messageType: "system"` task
   * (e.g. a project bring-up), a summary of the run rather than the agent's
   * instructions.
   */
  goal!: string;
  /** Who started it. Defaults to "user" against an older API. */
  messageType!: TaskMessageType;
  status!: TaskStatus;
  createdAt!: string;
  result?: string;
  question?: string;
  /** The latest progress note while the task is running. */
  log?: string;
  /** What the task changed in the workspace, once it has. Absent when it changed nothing. */
  change?: TaskChange;
  /** Tokens, turns, time and cost, once the task has run. */
  usage?: TaskUsage;
  /** On the handle `create()` returns for a follow-up: the task it continues. */
  followUpOf?: string;
  /**
   * On the handle `create()` returns for a follow-up: false when the earlier
   * task left no conversation to pick up, so the agent works in the same
   * folder without that memory.
   */
  resumed?: boolean;

  constructor(http: Http, raw: TaskRaw) {
    super(http);
    this.assign(raw);
  }

  private assign(r: TaskRaw): void {
    this.id = r.id;
    this.serverId = r.serverId;
    this.projectId = r.projectId ?? null;
    this.goal = r.goal;
    this.messageType = r.messageType ?? "user";
    this.status = r.status;
    this.createdAt = r.createdAt;
    this.result = r.result;
    this.question = r.question;
    this.log = r.log;
    this.change = r.change;
    this.usage = r.usage;
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<{ task: TaskRaw }>({
      path: `/servers/${seg(this.serverId)}/tasks/${seg(this.id)}`,
    });
    this.assign(r.task);
    return this;
  }

  /** Resolve once the task reaches a terminal state (done, failed, cancelled, awaiting_input). */
  async wait(opts: WaitOptions<this> = {}): Promise<this> {
    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 300_000);
    while (!TASK_TERMINAL_STATES.includes(this.status)) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Server4AgentError("wait() aborted.");
      if (Date.now() >= deadline) {
        throw new APITimeoutError(`Task ${this.id} still ${this.status} after timeout.`);
      }
      await sleep(interval);
      await this.refresh();
      opts.onProgress?.(this);
    }
    return this;
  }
}

/** A structured build pipeline running on a server. */
export class Build extends Handle {
  id!: string;
  serverId!: string;
  goal!: string;
  status!: BuildStatus;
  steps!: BuildStep[];
  artifacts!: string[];
  url!: string | null;
  createdAt!: string;

  constructor(http: Http, raw: BuildRaw) {
    super(http);
    this.assign(raw);
  }

  private assign(r: BuildRaw): void {
    this.id = r.id;
    this.serverId = r.serverId;
    this.goal = r.goal;
    this.status = r.status;
    this.steps = r.steps ?? [];
    this.artifacts = r.artifacts ?? [];
    this.url = r.url ?? null;
    this.createdAt = r.createdAt;
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<{ build: BuildRaw }>({
      path: `/servers/${seg(this.serverId)}/builds/${seg(this.id)}`,
    });
    this.assign(r.build);
    return this;
  }

  /** Resolve once the build completes. */
  async wait(opts: WaitOptions<this> = {}): Promise<this> {
    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    while (!BUILD_TERMINAL_STATES.includes(this.status)) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Server4AgentError("wait() aborted.");
      if (Date.now() >= deadline) {
        throw new APITimeoutError(`Build ${this.id} still ${this.status} after timeout.`);
      }
      await sleep(interval);
      await this.refresh();
      opts.onProgress?.(this);
    }
    return this;
  }
}

/**
 * A tuning run: the on-server agent fixing an agent from an evaluation
 * platform's report, then reporting back what changed. Reading it is what
 * advances it, so `refresh()` and `wait()` also move it along.
 */
export class TuningSession extends Handle {
  id!: string;
  serverId!: string;
  projectId!: string;
  /** The agent run doing the fix. Null while status is "building". */
  runId!: string | null;
  /** The bring-up run, when this session built the project from the agent's own source. */
  buildRunId!: string | null;
  /** The improvement proposal id on the evaluation platform. */
  proposalId!: string;
  evaluationApiBase!: string;
  /** Name of the secret holding the evaluation API key. Never its value. */
  keySecretKey!: string;
  /** Where the brief was written, relative to the project's workspace. Null until the fix run starts. */
  briefPath!: string | null;
  briefRevision!: string | null;
  status!: TuningStatus;
  changeSummary!: string | null;
  changedFiles!: string[];
  deploymentUrl!: string | null;
  /** When the outcome reached the platform. Null until it has. */
  reportedAt!: string | null;
  /** Why the last report attempt failed. The next read retries. */
  reportError!: string | null;
  createdAt!: string;
  updatedAt!: string;
  /**
   * The agent run behind the session as of the last `get()` or `refresh()`:
   * the bring-up while status is "building", the fix after that. Null from
   * `list()`, `start()` and `report()`, which do not read it.
   */
  run: Task | null = null;

  constructor(http: Http, raw: TuningSessionRaw, run?: RunRaw | null) {
    super(http);
    this.assign(raw, run);
  }

  private assign(r: TuningSessionRaw, run?: RunRaw | null): void {
    this.id = r.id;
    this.serverId = r.serverId;
    this.projectId = r.projectId;
    this.runId = r.runId ?? null;
    this.buildRunId = r.buildRunId ?? null;
    this.proposalId = r.proposalId;
    this.evaluationApiBase = r.evaluationApiBase;
    this.keySecretKey = r.keySecretKey;
    this.briefPath = r.briefPath ?? null;
    this.briefRevision = r.briefRevision ?? null;
    this.status = r.status;
    this.changeSummary = r.changeSummary ?? null;
    this.changedFiles = r.changedFiles ?? [];
    this.deploymentUrl = r.deploymentUrl ?? null;
    this.reportedAt = r.reportedAt ?? null;
    this.reportError = r.reportError ?? null;
    this.createdAt = r.createdAt;
    this.updatedAt = r.updatedAt;
    if (run !== undefined) this.run = run ? new Task(this.http, runToTask(run)) : null;
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<{ session: TuningSessionRaw; run: RunRaw | null }>({
      path: `/tuning/sessions/${seg(this.id)}`,
    });
    this.assign(r.session, r.run ?? null);
    return this;
  }

  /**
   * Send your own account of the fix to the evaluation platform, instead of
   * letting it be read off the run's final message.
   */
  async report(result: TuningReport): Promise<this> {
    const r = await this.http.request<{ session: TuningSessionRaw }>({
      method: "PATCH",
      path: `/tuning/sessions/${seg(this.id)}`,
      body: tuningReportBody(result),
    });
    this.assign(r.session);
    return this;
  }

  /**
   * Resolve once the session is "reported" or "failed", or its run stops to
   * ask a question ("awaiting_input"), since nothing moves until someone
   * answers it. Each poll is a read, which is what advances the session.
   */
  async wait(opts: WaitOptions<this> = {}): Promise<this> {
    const interval = opts.pollIntervalMs ?? 2000;
    const deadline = Date.now() + (opts.timeoutMs ?? 1_800_000);
    while (!TUNING_TERMINAL_STATES.includes(this.status) && this.run?.status !== "awaiting_input") {
      if (opts.signal?.aborted) throw opts.signal.reason ?? new Server4AgentError("wait() aborted.");
      if (Date.now() >= deadline) {
        throw new APITimeoutError(`Tuning session ${this.id} still ${this.status} after timeout.`);
      }
      await sleep(interval);
      await this.refresh();
      opts.onProgress?.(this);
    }
    return this;
  }
}

/** What `tuning.start()` returned. */
export interface TuningStart {
  session: TuningSession;
  /**
   * False when a run already existed for this proposal: that run comes back
   * instead of a second one starting on the same brief.
   */
  started: boolean;
  /**
   * False when the brief was issued before the platform finished its analysis,
   * so it carries per-case judgements but no summarised diagnosis. Null when
   * the API did not say (an existing run, or a build from source).
   */
  analysisReady: boolean | null;
  /** Set when this call built a new project from the agent's own source. */
  built: TuningBuild | null;
  /** The run started but the platform could not be told. The next status report retries. */
  warning: string | null;
}

function tuningReportBody(r: TuningReport) {
  return {
    change_summary: r.changeSummary,
    changed_files: r.changedFiles,
    deployment_url: r.deploymentUrl,
    failed: r.failed,
  };
}

// =============================================================================
// Scoped sub-resources, reached via a handle (server.tasks, project.secrets, ...).
// =============================================================================

class ScopedProjects {
  constructor(
    private readonly http: Http,
    private readonly serverId: string,
  ) {}

  async list(): Promise<Project[]> {
    const r = await this.http.request<{ projects: ProjectRaw[] }>({
      path: `/servers/${seg(this.serverId)}/projects`,
    });
    return r.projects.map((p) => new Project(this.http, p));
  }

  async create(opts: CreateProjectOptions = {}): Promise<Project> {
    const r = await this.http.request<ProjectRaw>({
      method: "POST",
      path: `/servers/${seg(this.serverId)}/projects`,
      body: createProjectBody(opts),
    });
    return new Project(this.http, r);
  }

  /**
   * Recreate a project on this server from a bundle `project.export()` made,
   * here or on another deployment. `bundle` is the file's bytes, or the file
   * already base64 encoded. The project lands private, environment variables
   * are bound only where this account already holds a value (see
   * `missingEnv`), and bring-up starts straight away. The bundle travels in
   * the request body, so the API's request size limit applies.
   */
  async import(bundle: Uint8Array | string, opts: { name?: string } = {}): Promise<ImportedProject> {
    const encoded =
      typeof bundle === "string"
        ? bundle.replace(/\s+/g, "") // tolerate a line-wrapped `base64` dump
        : Buffer.from(bundle).toString("base64");
    const r = await this.http.request<ImportedProjectRaw>({
      method: "POST",
      path: `/servers/${seg(this.serverId)}/projects/import`,
      body: { bundle: encoded, name: opts.name },
    });
    return {
      project: new Project(this.http, r),
      initRunId: r.init_run_id ?? null,
      importedFrom: r.imported_from ?? null,
      exportedAt: r.exported_at,
      boundEnv: r.bound_env ?? [],
      missingEnv: r.missing_env ?? [],
      warnings: r.warnings ?? [],
    };
  }
}

class ScopedTasks {
  constructor(
    private readonly http: Http,
    private readonly serverId: string,
  ) {}

  /**
   * Give the agent a goal. `projectId` runs it in that project's folder
   * instead of the workspace root. `followUpOf` continues an earlier task's
   * conversation, in the same folder, so the agent remembers what it did: use
   * it to answer a task that is "awaiting_input", or to ask for changes.
   */
  async create(goal: string, opts: { projectId?: string; followUpOf?: string } = {}): Promise<Task> {
    const r = await this.http.request<{
      task_id: string;
      status: TaskStatus;
      project_id?: string | null;
      follow_up_of?: string;
      resumed?: boolean;
      createdAt?: string;
    }>({
      method: "POST",
      path: `/servers/${seg(this.serverId)}/tasks`,
      body: { goal, project_id: opts.projectId, follow_up_of: opts.followUpOf },
    });
    const task = new Task(this.http, {
      id: r.task_id,
      serverId: this.serverId,
      projectId: r.project_id ?? opts.projectId ?? null,
      goal,
      // You just created it, so it is your message by definition.
      messageType: "user",
      status: r.status,
      createdAt: r.createdAt ?? "",
    });
    if (r.follow_up_of !== undefined) task.followUpOf = r.follow_up_of;
    if (r.resumed !== undefined) task.resumed = r.resumed;
    return task;
  }

  async list(): Promise<Task[]> {
    const r = await this.http.request<{ tasks: TaskRaw[] }>({
      path: `/servers/${seg(this.serverId)}/tasks`,
    });
    return r.tasks.map((t) => new Task(this.http, t));
  }

  async get(taskId: string): Promise<Task> {
    const r = await this.http.request<{ task: TaskRaw }>({
      path: `/servers/${seg(this.serverId)}/tasks/${seg(taskId)}`,
    });
    return new Task(this.http, r.task);
  }
}

class ScopedBuilds {
  constructor(
    private readonly http: Http,
    private readonly serverId: string,
  ) {}

  async start(goal: string): Promise<Build> {
    const r = await this.http.request<{
      build_id: string;
      status: BuildStatus;
      steps?: BuildStep[];
      createdAt?: string;
    }>({
      method: "POST",
      path: `/servers/${seg(this.serverId)}/builds`,
      body: { goal },
    });
    return new Build(this.http, {
      id: r.build_id,
      serverId: this.serverId,
      goal,
      status: r.status,
      steps: r.steps ?? [],
      createdAt: r.createdAt ?? "",
    });
  }

  async list(): Promise<Build[]> {
    const r = await this.http.request<{ builds: BuildRaw[] }>({
      path: `/servers/${seg(this.serverId)}/builds`,
    });
    return r.builds.map((b) => new Build(this.http, b));
  }

  async get(buildId: string): Promise<Build> {
    const r = await this.http.request<{ build: BuildRaw }>({
      path: `/servers/${seg(this.serverId)}/builds/${seg(buildId)}`,
    });
    return new Build(this.http, r.build);
  }
}

class ScopedFiles {
  constructor(
    private readonly http: Http,
    private readonly serverId: string,
  ) {}

  async list(): Promise<string[]> {
    const r = await this.http.request<{ files: string[] }>({
      path: `/servers/${seg(this.serverId)}/files`,
    });
    return r.files;
  }

  async read(path: string): Promise<string> {
    const r = await this.http.request<{ content: string }>({
      path: `/servers/${seg(this.serverId)}/files`,
      query: { path },
    });
    return r.content;
  }

  /** Read a binary file (e.g. a generated .xlsx) without corrupting its bytes. */
  async readBinary(path: string): Promise<Buffer> {
    const r = await this.http.request<{ content: string }>({
      path: `/servers/${seg(this.serverId)}/files`,
      query: { path, encoding: "base64" },
    });
    return Buffer.from(r.content, "base64");
  }

  /** `content` may be a string (written as UTF-8) or raw bytes (written as-is, base64 on the wire). */
  async write(path: string, content: string | Uint8Array): Promise<void> {
    const isBinary = content instanceof Uint8Array;
    await this.http.request({
      method: "PUT",
      path: `/servers/${seg(this.serverId)}/files`,
      body: isBinary
        ? { path, content: Buffer.from(content).toString("base64"), encoding: "base64" }
        : { path, content },
    });
  }

  async delete(path: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/servers/${seg(this.serverId)}/files`,
      query: { path },
    });
  }

  /** Mint a signed, expiring link anyone can use to download this one file, no login required. */
  async getDownloadUrl(
    path: string,
    opts: { ttlSeconds?: number } = {},
  ): Promise<{ url: string; expiresAt: string }> {
    const r = await this.http.request<{ url: string; expires_at: string }>({
      path: `/servers/${seg(this.serverId)}/files/download-url`,
      query: {
        path,
        ttl_seconds: opts.ttlSeconds != null ? String(opts.ttlSeconds) : undefined,
      },
    });
    return { url: r.url, expiresAt: r.expires_at };
  }
}

/**
 * Secrets in one scope: a server's (`server.secrets`) or a project's
 * (`project.secrets`). Values are write-only and never come back.
 */
class ScopedSecrets {
  constructor(
    private readonly http: Http,
    private readonly path: string,
  ) {}

  async list(): Promise<Secret[]> {
    const r = await this.http.request<{ secrets: SecretRaw[] }>({ path: this.path });
    return r.secrets.map(toSecret);
  }

  /**
   * Create or update each secret by key and bind it to this scope. A key has
   * one value per account, so this changes it everywhere it is bound.
   * Resolves to the scope's secrets after the change.
   */
  async set(secrets: SecretInput[]): Promise<Secret[]> {
    const r = await this.http.request<{ secrets: SecretRaw[] }>({
      method: "PUT",
      path: this.path,
      body: { secrets },
    });
    return r.secrets.map(toSecret);
  }
}

// =============================================================================
// Top-level resources: the flat client.servers.* API.
// =============================================================================

class ServersResource {
  constructor(private readonly http: Http) {}

  /** `secrets` are set and bound server-wide, so every project on the server sees them. */
  async create(
    opts: {
      task?: string;
      tier?: ServerTier;
      kind?: ServerKind;
      region?: string;
      secrets?: SecretInput[];
    } = {},
  ): Promise<Server> {
    const r = await this.http.request<{
      id: string;
      url: string | null;
      status: ServerStatus;
      tier: ServerTier;
      kind?: ServerKind;
    }>({ method: "POST", path: "/servers", body: opts });
    return new Server(this.http, {
      id: r.id,
      task: opts.task,
      tier: r.tier,
      // Prefer what the control plane says it built; fall back to what was
      // asked for, since an older one answers without a kind at all.
      kind: r.kind ?? opts.kind,
      status: r.status,
      region: opts.region,
      publicUrl: r.url,
    });
  }

  async list(): Promise<Server[]> {
    const r = await this.http.request<{ servers: ServerRaw[] }>({ path: "/servers" });
    return r.servers.map((s) => new Server(this.http, s));
  }

  async get(serverId: string): Promise<Server> {
    const r = await this.http.request<{ server: ServerRaw }>({ path: `/servers/${seg(serverId)}` });
    return new Server(this.http, r.server);
  }

  async update(serverId: string, patch: { task?: string; region?: string }): Promise<Server> {
    const r = await this.http.request<{ server: ServerRaw }>({
      method: "PATCH",
      path: `/servers/${seg(serverId)}`,
      body: patch,
    });
    return new Server(this.http, r.server);
  }

  async delete(serverId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/servers/${seg(serverId)}` });
  }

  control(serverId: string, action: ServerAction): Promise<{ id: string; status: ServerStatus }> {
    return this.http.request({ method: "POST", path: `/servers/${seg(serverId)}/actions`, body: { action } });
  }

  async exec(serverId: string, command: string, opts: { projectId?: string } = {}): Promise<string> {
    const r = await this.http.request<{ stdout: string }>({
      method: "POST",
      path: `/servers/${seg(serverId)}/exec`,
      body: { command, project_id: opts.projectId },
    });
    return r.stdout;
  }

  /** See `Server.deploy()`. Resolves to the project's public URL. */
  async deploy(serverId: string, opts: { projectId?: string } = {}): Promise<string> {
    return (await requestDeploy(this.http, serverId, opts.projectId)).url;
  }

  listDeployments(serverId: string): Promise<Deployment[]> {
    return requestDeployments(this.http, serverId);
  }

  /** See `Server.logs()`. */
  logs(
    serverId: string,
    opts: { projectId?: string; lines?: number } = {},
  ): Promise<LogsSnapshot | null> {
    return requestLogs(this.http, serverId, opts);
  }
}

class ProjectsResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<Project[]> {
    const r = await this.http.request<{ projects: ProjectRaw[] }>({ path: "/projects" });
    return r.projects.map((p) => new Project(this.http, p));
  }

  listForServer(serverId: string): Promise<Project[]> {
    return new ScopedProjects(this.http, serverId).list();
  }

  create(serverId: string, opts: CreateProjectOptions = {}): Promise<Project> {
    return new ScopedProjects(this.http, serverId).create(opts);
  }

  async get(projectId: string): Promise<Project> {
    const r = await this.http.request<ProjectRaw>({ path: `/projects/${seg(projectId)}` });
    return new Project(this.http, r);
  }

  async update(projectId: string, patch: UpdateProjectOptions): Promise<Project> {
    const r = await this.http.request<ProjectRaw>({
      method: "PATCH",
      path: `/projects/${seg(projectId)}`,
      body: updateProjectBody(patch),
    });
    return new Project(this.http, r);
  }

  async delete(projectId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/projects/${seg(projectId)}` });
  }

  async cleanup(projectId: string): Promise<void> {
    await this.http.request({ method: "POST", path: `/projects/${seg(projectId)}/cleanup` });
  }

  /** See `Project.start()`. */
  start(projectId: string, command: string, opts: { name?: string } = {}): Promise<StartAppResult> {
    return requestStart(this.http, projectId, command, opts);
  }

  /** See `Project.init()`. */
  init(projectId: string, opts: { proceed?: boolean } = {}): Promise<ProjectInitResult> {
    return requestInit(this.http, projectId, opts);
  }

  /** See `Project.export()`. */
  export(projectId: string, opts: { ttlSeconds?: number } = {}): Promise<ProjectExport> {
    return requestExport(this.http, projectId, opts);
  }

  /** Import a project onto a server from an export bundle. See `server.projects.import()`. */
  import(serverId: string, bundle: Uint8Array | string, opts?: { name?: string }): Promise<ImportedProject> {
    return new ScopedProjects(this.http, serverId).import(bundle, opts);
  }
}

class TemplatesResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<ProjectTemplate[]> {
    const r = await this.http.request<{
      templates: (Omit<ProjectTemplate, "sourceKind"> & { source_kind?: ProjectTemplate["sourceKind"] })[];
    }>({ path: "/templates" });
    return r.templates.map(({ source_kind, ...t }) => ({ ...t, sourceKind: source_kind ?? null }));
  }
}

class TasksResource {
  constructor(private readonly http: Http) {}

  create(
    serverId: string,
    goal: string,
    opts?: { projectId?: string; followUpOf?: string },
  ): Promise<Task> {
    return new ScopedTasks(this.http, serverId).create(goal, opts);
  }
  list(serverId: string): Promise<Task[]> {
    return new ScopedTasks(this.http, serverId).list();
  }
  get(serverId: string, taskId: string): Promise<Task> {
    return new ScopedTasks(this.http, serverId).get(taskId);
  }
}

class BuildsResource {
  constructor(private readonly http: Http) {}

  start(serverId: string, goal: string): Promise<Build> {
    return new ScopedBuilds(this.http, serverId).start(goal);
  }
  list(serverId: string): Promise<Build[]> {
    return new ScopedBuilds(this.http, serverId).list();
  }
  get(serverId: string, buildId: string): Promise<Build> {
    return new ScopedBuilds(this.http, serverId).get(buildId);
  }
}

class FilesResource {
  constructor(private readonly http: Http) {}

  list(serverId: string): Promise<string[]> {
    return new ScopedFiles(this.http, serverId).list();
  }
  read(serverId: string, path: string): Promise<string> {
    return new ScopedFiles(this.http, serverId).read(path);
  }
  readBinary(serverId: string, path: string): Promise<Buffer> {
    return new ScopedFiles(this.http, serverId).readBinary(path);
  }
  write(serverId: string, path: string, content: string | Uint8Array): Promise<void> {
    return new ScopedFiles(this.http, serverId).write(path, content);
  }
  delete(serverId: string, path: string): Promise<void> {
    return new ScopedFiles(this.http, serverId).delete(path);
  }
  getDownloadUrl(
    serverId: string,
    path: string,
    opts?: { ttlSeconds?: number },
  ): Promise<{ url: string; expiresAt: string }> {
    return new ScopedFiles(this.http, serverId).getDownloadUrl(path, opts);
  }
}

class SecretsResource {
  constructor(private readonly http: Http) {}

  /** Every secret on the account, with where each is bound. Never the values. */
  async list(): Promise<Secret[]> {
    const r = await this.http.request<{ secrets: SecretRaw[] }>({ path: "/secrets" });
    return r.secrets.map(toSecret);
  }

  /**
   * Create a secret, or update the value of the one with this key. Binds it
   * nowhere: use `setForServer()` / `setForProject()` (or `server.secrets`,
   * `project.secrets`) to set and bind in one call.
   */
  async set(secret: SecretInput): Promise<Secret> {
    const r = await this.http.request<SecretRaw>({ method: "PUT", path: "/secrets", body: secret });
    return toSecret(r);
  }

  /** Delete a secret and every binding it has, on every server and project. */
  async delete(secretId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/secrets/${seg(secretId)}` });
  }

  /** Secrets bound server-wide on this server. */
  listForServer(serverId: string): Promise<Secret[]> {
    return new ScopedSecrets(this.http, `/servers/${seg(serverId)}/secrets`).list();
  }

  /** Set and bind secrets server-wide; resolves to the server's secrets after the change. */
  setForServer(serverId: string, secrets: SecretInput[]): Promise<Secret[]> {
    return new ScopedSecrets(this.http, `/servers/${seg(serverId)}/secrets`).set(secrets);
  }

  /** Secrets the project sees: its own plus its server's server-wide ones. */
  listForProject(projectId: string): Promise<Secret[]> {
    return new ScopedSecrets(this.http, `/projects/${seg(projectId)}/secrets`).list();
  }

  /** Set and bind secrets to one project; resolves to what the project sees after the change. */
  setForProject(projectId: string, secrets: SecretInput[]): Promise<Secret[]> {
    return new ScopedSecrets(this.http, `/projects/${seg(projectId)}/secrets`).set(secrets);
  }
}

class TuningResource {
  constructor(private readonly http: Http) {}

  /** Tuning runs, newest first, optionally narrowed to one project or status. */
  async list(opts: { projectId?: string; status?: TuningStatus } = {}): Promise<TuningSession[]> {
    const r = await this.http.request<{ sessions: TuningSessionRaw[] }>({
      path: "/tuning/sessions",
      query: { project_id: opts.projectId, status: opts.status },
    });
    return r.sessions.map((t) => new TuningSession(this.http, t));
  }

  /**
   * Start a tuning run: fetch the platform's brief for a proposal, write it
   * into the project's workspace, and set the agent to fix what it found.
   * Needs a secret on the account holding the evaluation API key. Calling
   * again with the same `proposalId` returns the run already under way.
   */
  async start(opts: StartTuningOptions): Promise<TuningStart> {
    const { status, data: r } = await this.http.send<{
      session: TuningSessionRaw;
      analysisReady?: boolean;
      built?: TuningBuild;
      warning?: string;
    }>({
      method: "POST",
      path: "/tuning/sessions",
      body: {
        proposal_id: opts.proposalId,
        project_id: opts.projectId,
        server_id: opts.serverId,
        evaluation_api_base: opts.evaluationApiBase,
        key_secret: opts.keySecret,
      },
    });
    return {
      session: new TuningSession(this.http, r.session),
      started: status === 201,
      analysisReady: r.analysisReady ?? null,
      built: r.built ?? null,
      warning: r.warning ?? null,
    };
  }

  /** Read a tuning run, which also advances it. `session.run` is filled in. */
  async get(tuningSessionId: string): Promise<TuningSession> {
    const r = await this.http.request<{ session: TuningSessionRaw; run: RunRaw | null }>({
      path: `/tuning/sessions/${seg(tuningSessionId)}`,
    });
    return new TuningSession(this.http, r.session, r.run ?? null);
  }

  /** See `TuningSession.report()`. */
  async report(tuningSessionId: string, result: TuningReport): Promise<TuningSession> {
    const r = await this.http.request<{ session: TuningSessionRaw }>({
      method: "PATCH",
      path: `/tuning/sessions/${seg(tuningSessionId)}`,
      body: tuningReportBody(result),
    });
    return new TuningSession(this.http, r.session);
  }
}

class KeysResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<ApiKey[]> {
    const r = await this.http.request<{ keys: ApiKeyRaw[] }>({ path: "/keys" });
    return r.keys.map(toApiKey);
  }

  async create(label: string): Promise<CreatedApiKey> {
    const r = await this.http.request<ApiKeyRaw & { key: string }>({
      method: "POST",
      path: "/keys",
      body: { label },
    });
    return { ...toApiKey(r), key: r.key };
  }

  async updateScope(
    keyId: string,
    scope: { allowedServerIds?: string[]; allowedProjectIds?: string[] },
  ): Promise<{ id: string; allowedServerIds: string[]; allowedProjectIds: string[] }> {
    const r = await this.http.request<{
      id: string;
      allowed_server_ids: string[];
      allowed_project_ids: string[];
    }>({
      method: "PATCH",
      path: `/keys/${seg(keyId)}`,
      body: {
        allowed_server_ids: scope.allowedServerIds ?? [],
        allowed_project_ids: scope.allowedProjectIds ?? [],
      },
    });
    return { id: r.id, allowedServerIds: r.allowed_server_ids, allowedProjectIds: r.allowed_project_ids };
  }

  async revoke(keyId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/keys/${seg(keyId)}` });
  }
}

class WebhooksResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<Webhook[]> {
    const r = await this.http.request<{ webhooks: WebhookRaw[] }>({ path: "/webhooks" });
    return r.webhooks.map(toWebhook);
  }

  async create(url: string, events?: WebhookEvent[]): Promise<CreatedWebhook> {
    const r = await this.http.request<WebhookRaw & { secret: string }>({
      method: "POST",
      path: "/webhooks",
      body: { url, events },
    });
    return { ...toWebhook(r), secret: r.secret };
  }

  async delete(webhookId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/webhooks/${seg(webhookId)}` });
  }
}

/**
 * Client for the Server4Agent REST API.
 *
 * This SDK is for the code *around* your agent: your backend, a CI job, a
 * webhook receiver, an admin script. If your agent itself does tool-calling,
 * point it at the MCP server directly; it doesn't need this.
 *
 * ```ts
 * import { Server4Agent } from "@server4agent/sdk";
 *
 * const client = new Server4Agent(); // reads SERVER4AGENT_API_KEY
 * const server = await client.servers.create({ tier: "small" });
 * const build = await (await server.builds.start("a FastAPI todo API")).wait();
 * console.log(build.url);
 * ```
 */
export class Server4Agent {
  private readonly http: Http;

  readonly servers: ServersResource;
  readonly projects: ProjectsResource;
  readonly templates: TemplatesResource;
  readonly tasks: TasksResource;
  readonly builds: BuildsResource;
  readonly files: FilesResource;
  readonly secrets: SecretsResource;
  readonly tuning: TuningResource;
  readonly keys: KeysResource;
  readonly webhooks: WebhooksResource;

  constructor(options: Server4AgentOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("SERVER4AGENT_API_KEY");
    if (!apiKey) {
      throw new Error("Server4Agent: no API key. Pass { apiKey } or set SERVER4AGENT_API_KEY.");
    }
    this.http = new Http({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      apiKey,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      fetch: options.fetch,
    });

    this.servers = new ServersResource(this.http);
    this.projects = new ProjectsResource(this.http);
    this.templates = new TemplatesResource(this.http);
    this.tasks = new TasksResource(this.http);
    this.builds = new BuildsResource(this.http);
    this.files = new FilesResource(this.http);
    this.secrets = new SecretsResource(this.http);
    this.tuning = new TuningResource(this.http);
    this.keys = new KeysResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
  }

  /**
   * The account this key acts on, its spend against its budget, and how many
   * servers, projects and keys it holds. Check it before a run rather than
   * finding the ceiling with a 402. Needs an account-wide key.
   */
  async me(): Promise<AccountSummary> {
    const r = await this.http.request<{
      account: { name?: string | null; email?: string | null; plan: string };
      you?: { name?: string | null; email?: string | null };
      usage: {
        spend_usd: number;
        included_credits_usd: number;
        budget_cap_usd?: number | null;
        bonus_usd?: number;
        hard_limit_usd?: number | null;
        overage_allowed?: boolean;
        blocked: boolean;
        reason?: AccountSummary["usage"]["reason"];
      };
      authenticated_key: { id: string; label: string };
      servers: number;
      projects: number;
      keys: number;
    }>({ path: "/me" });
    return {
      account: { name: r.account.name ?? null, email: r.account.email ?? null, plan: r.account.plan },
      you: r.you ? { name: r.you.name ?? null, email: r.you.email ?? null } : null,
      usage: {
        spendUsd: r.usage.spend_usd,
        includedCreditsUsd: r.usage.included_credits_usd,
        budgetCapUsd: r.usage.budget_cap_usd ?? null,
        bonusUsd: r.usage.bonus_usd ?? 0,
        hardLimitUsd: r.usage.hard_limit_usd ?? null,
        overageAllowed: r.usage.overage_allowed ?? false,
        blocked: r.usage.blocked,
        reason: r.usage.reason ?? null,
      },
      authenticatedKey: { id: r.authenticated_key.id, label: r.authenticated_key.label },
      servers: r.servers,
      projects: r.projects,
      keys: r.keys,
    };
  }
}
