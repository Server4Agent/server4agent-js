import { Http } from "./http.js";
import { APITimeoutError, Server4AgentError } from "./errors.js";
import {
  type ApiKey,
  type BuildStep,
  type BuildStatus,
  BUILD_TERMINAL_STATES,
  type CreateProjectOptions,
  type CreatedApiKey,
  type CreatedWebhook,
  type Deployment,
  type ProjectLifecycle,
  type ProjectRuntimeStatus,
  type ProjectTemplate,
  type ProjectVisibility,
  type Server4AgentOptions,
  type ServerAction,
  type ServerStatus,
  type ServerTier,
  type TaskStatus,
  TASK_TERMINAL_STATES,
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
  lifecycle: ProjectLifecycle;
  runtime_status: ProjectRuntimeStatus;
  template: string | null;
  url: string | null;
  created_at: string;
  updated_at: string;
}

interface TaskRaw {
  id: string;
  serverId: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  result?: string;
  question?: string;
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

// =============================================================================
// Handles — returned by create()/get(); data records you can also act on.
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

/** A compute server. Its sub-resources (`.tasks`, `.builds`, `.files`, `.projects`) are scoped to it. */
export class Server extends Handle {
  id!: string;
  task!: string;
  tier!: ServerTier;
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

  /** Run a shell command on the server; resolves to stdout. */
  async exec(command: string): Promise<string> {
    const r = await this.http.request<{ stdout: string }>({
      method: "POST",
      path: `/servers/${seg(this.id)}/exec`,
      body: { command },
    });
    return r.stdout;
  }

  /** Publish the current workspace to a live public URL; resolves to the URL. */
  async deploy(): Promise<string> {
    const r = await this.http.request<{ url: string }>({
      method: "POST",
      path: `/servers/${seg(this.id)}/deployments`,
    });
    return r.url;
  }

  async deployments(): Promise<Deployment[]> {
    const r = await this.http.request<{ deployments: Deployment[] }>({
      path: `/servers/${seg(this.id)}/deployments`,
    });
    return r.deployments;
  }
}

/** A workspace + app inside a server. */
export class Project extends Handle {
  id!: string;
  serverId!: string;
  name!: string;
  slug!: string;
  description!: string | null;
  visibility!: ProjectVisibility;
  lifecycle!: ProjectLifecycle;
  runtimeStatus!: ProjectRuntimeStatus;
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
    this.lifecycle = r.lifecycle;
    this.runtimeStatus = r.runtime_status;
    this.template = r.template;
    this.url = r.url;
    this.createdAt = r.created_at;
    this.updatedAt = r.updated_at;
  }

  async refresh(): Promise<this> {
    const r = await this.http.request<ProjectRaw>({ path: `/projects/${seg(this.id)}` });
    this.assign(r);
    return this;
  }

  async update(patch: {
    name?: string;
    description?: string;
    visibility?: ProjectVisibility;
    lifecycle?: ProjectLifecycle;
  }): Promise<this> {
    const r = await this.http.request<ProjectRaw>({
      method: "PATCH",
      path: `/projects/${seg(this.id)}`,
      body: patch,
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
}

interface WaitOptions<T> {
  /** Milliseconds between polls. Default 2000. */
  pollIntervalMs?: number;
  /** Give up after this many milliseconds. Default 300000 (tasks) / 600000 (builds). */
  timeoutMs?: number;
  /** Called with the handle after each poll — stream progress to a log or UI. */
  onProgress?: (self: T) => void;
  /** Stop waiting when this signal aborts. */
  signal?: AbortSignal;
}

/** An agent goal running on a server. */
export class Task extends Handle {
  id!: string;
  serverId!: string;
  goal!: string;
  status!: TaskStatus;
  createdAt!: string;
  result?: string;
  question?: string;

  constructor(http: Http, raw: TaskRaw) {
    super(http);
    this.assign(raw);
  }

  private assign(r: TaskRaw): void {
    this.id = r.id;
    this.serverId = r.serverId;
    this.goal = r.goal;
    this.status = r.status;
    this.createdAt = r.createdAt;
    this.result = r.result;
    this.question = r.question;
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

// =============================================================================
// Scoped sub-resources — reached via a Server handle (server.tasks, ...).
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
      body: opts,
    });
    return new Project(this.http, r);
  }
}

class ScopedTasks {
  constructor(
    private readonly http: Http,
    private readonly serverId: string,
  ) {}

  async create(goal: string): Promise<Task> {
    const r = await this.http.request<{ task_id: string; status: TaskStatus; createdAt?: string }>({
      method: "POST",
      path: `/servers/${seg(this.serverId)}/tasks`,
      body: { goal },
    });
    return new Task(this.http, {
      id: r.task_id,
      serverId: this.serverId,
      goal,
      status: r.status,
      createdAt: r.createdAt ?? "",
    });
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

  async write(path: string, content: string): Promise<void> {
    await this.http.request({
      method: "PUT",
      path: `/servers/${seg(this.serverId)}/files`,
      body: { path, content },
    });
  }

  async delete(path: string): Promise<void> {
    await this.http.request({
      method: "DELETE",
      path: `/servers/${seg(this.serverId)}/files`,
      query: { path },
    });
  }
}

// =============================================================================
// Top-level resources — the flat client.servers.* API.
// =============================================================================

class ServersResource {
  constructor(private readonly http: Http) {}

  async create(opts: { task?: string; tier?: ServerTier; region?: string } = {}): Promise<Server> {
    const r = await this.http.request<{
      id: string;
      url: string | null;
      status: ServerStatus;
      tier: ServerTier;
    }>({ method: "POST", path: "/servers", body: opts });
    return new Server(this.http, {
      id: r.id,
      task: opts.task,
      tier: r.tier,
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

  async exec(serverId: string, command: string): Promise<string> {
    const r = await this.http.request<{ stdout: string }>({
      method: "POST",
      path: `/servers/${seg(serverId)}/exec`,
      body: { command },
    });
    return r.stdout;
  }

  async deploy(serverId: string): Promise<string> {
    const r = await this.http.request<{ url: string }>({
      method: "POST",
      path: `/servers/${seg(serverId)}/deployments`,
    });
    return r.url;
  }

  async listDeployments(serverId: string): Promise<Deployment[]> {
    const r = await this.http.request<{ deployments: Deployment[] }>({
      path: `/servers/${seg(serverId)}/deployments`,
    });
    return r.deployments;
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

  async update(
    projectId: string,
    patch: {
      name?: string;
      description?: string;
      visibility?: ProjectVisibility;
      lifecycle?: ProjectLifecycle;
    },
  ): Promise<Project> {
    const r = await this.http.request<ProjectRaw>({
      method: "PATCH",
      path: `/projects/${seg(projectId)}`,
      body: patch,
    });
    return new Project(this.http, r);
  }

  async delete(projectId: string): Promise<void> {
    await this.http.request({ method: "DELETE", path: `/projects/${seg(projectId)}` });
  }

  async cleanup(projectId: string): Promise<void> {
    await this.http.request({ method: "POST", path: `/projects/${seg(projectId)}/cleanup` });
  }
}

class TemplatesResource {
  constructor(private readonly http: Http) {}

  async list(): Promise<ProjectTemplate[]> {
    const r = await this.http.request<{ templates: ProjectTemplate[] }>({ path: "/templates" });
    return r.templates;
  }
}

class TasksResource {
  constructor(private readonly http: Http) {}

  create(serverId: string, goal: string): Promise<Task> {
    return new ScopedTasks(this.http, serverId).create(goal);
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
  write(serverId: string, path: string, content: string): Promise<void> {
    return new ScopedFiles(this.http, serverId).write(path, content);
  }
  delete(serverId: string, path: string): Promise<void> {
    return new ScopedFiles(this.http, serverId).delete(path);
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
 * point it at the MCP server directly — it doesn't need this.
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
    this.keys = new KeysResource(this.http);
    this.webhooks = new WebhooksResource(this.http);
  }
}
