export type ServerTier = "small" | "medium" | "large";
/**
 * What kind of box a server is, orthogonal to its tier. "standard" is
 * headless; "browser" adds a screen with a browser on it, so a run can drive
 * sites that need a real one. A server from an API that predates the field
 * reads as "standard".
 */
export type ServerKind = "standard" | "browser";
export type ServerStatus = "running" | "sleeping" | "building";
export type ServerAction = "start" | "stop" | "restart";
export type ProjectVisibility = "public" | "private";
/**
 * Who may open a public project's URL. "team" puts it behind a Server4Agent
 * sign-in and membership of the owning account; "public" is anyone with the
 * link, which is the default and how every project behaved before this.
 */
export type ProjectAccess = "public" | "team";
export type ProjectLifecycle = "persistent" | "ephemeral";
export type ProjectRuntimeStatus = "unbuilt" | "running" | "paused";
export type TaskStatus = "running" | "completed" | "failed" | "awaiting_input" | "cancelled";
/**
 * Who started a task. "user" is one you created; "system" is one the platform
 * started for you, such as bringing up a project imported from git. A system
 * task's `goal` is a short summary of the run, not the instructions the agent
 * was given.
 */
export type TaskMessageType = "user" | "system";
export type BuildStatus = "queued" | "running" | "completed";
/**
 * A build is one agent run, and its steps move together: "running" while the
 * run works, "done" when it finished, "failed" when it did not. A failed
 * build's own `status` still reads "completed", so check the steps.
 */
export type BuildStepStatus = "pending" | "running" | "done" | "failed";
/**
 * How far a project's bring-up has got, from seeding the workspace to a
 * confirmed running service. "awaiting_plan" waits on someone to confirm how
 * the code installs and starts; "awaiting_secrets" waits on environment
 * variables the code needs (set them, or `init({ proceed: true })` to go on
 * without them). Ends at "ready" once the healthcheck passes, or "failed".
 */
export type ProjectInitPhase =
  | "seeding"
  | "awaiting_plan"
  | "awaiting_secrets"
  | "installing"
  | "starting"
  | "ready"
  | "failed";
/**
 * The outcome of a deploy. "live" means the project's URL answered with the
 * app; "publishing" means the project is public but the URL had not answered
 * yet when the API stopped waiting.
 */
export type DeployStatus = "live" | "publishing";

/** A task poll stops here: nothing further happens without you, or it's over. */
export const TASK_TERMINAL_STATES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "awaiting_input",
];
export const BUILD_TERMINAL_STATES: readonly BuildStatus[] = ["completed"];

/**
 * Where a tuning run is. "building" stands the agent's code up from its own
 * source first; "fixing" has the on-server agent working on the brief;
 * "reported" means the outcome reached the evaluation platform; "failed" means
 * the code could not be brought up or the fix did not land.
 */
export type TuningStatus = "building" | "fixing" | "reported" | "failed";
/** A tuning poll stops here: the outcome is reported, or the run is over. */
export const TUNING_TERMINAL_STATES: readonly TuningStatus[] = ["reported", "failed"];

/** What a task changed in the workspace, as one commit. */
export interface TaskChange {
  commit: string;
  /** The branch the task worked on before it was merged into the base branch. */
  branch?: string;
  mergeCommit?: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: string[];
}

/** What a task cost to run. */
export interface TaskUsage {
  /** USD. */
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  turns: number;
  durationMs: number;
  /**
   * Where `cost` came from. "reported" is an exact figure; the "estimated"
   * values are derived from token counts, so do not read them as precise.
   */
  costSource?: "reported" | "estimated" | "estimated-unpriced" | "unknown";
}

export interface BuildStep {
  key: string;
  label: string;
  status: BuildStepStatus;
}

/** A public project and its address. */
export interface Deployment {
  url: string;
  /** False while the project is paused. */
  live: boolean;
  /** The project this address belongs to. Null from an API that predates the field. */
  projectId: string | null;
}

/** What `deploy()` did. */
export interface DeployResult {
  /** The project's public URL. */
  url: string;
  status: DeployStatus;
  /** The project that was deployed, which matters when the API picked it for you. */
  projectId: string;
}

/** One log file's tail, from `logs()`. */
export interface LogFile {
  /** Workspace-relative path of the log file. */
  path: string;
  /** The project whose workspace folder holds the file, or null at the server root. */
  projectSlug: string | null;
  name: string;
  /** Full size of the file on disk; `tail` may be shorter. */
  sizeBytes: number;
  modifiedAt: string;
  /** The newest lines of the file, cut at a line boundary. */
  tail: string;
}

/**
 * Log-file tails from a server's background processes. Every long-running
 * process a project starts appends to a log file in its workspace.
 */
export interface LogsSnapshot {
  /**
   * When these tails were captured. The API reads them live, but when the
   * server cannot be reached (starting, restarting, or paused) it answers with
   * the last saved copy and does not say so, so compare this with the current
   * time before reading a tail as what is running now.
   */
  updatedAt: string;
  files: LogFile[];
}

/** A secret to set. The value is write-only: no read ever returns it. */
export interface SecretInput {
  /** Environment variable name: letters, digits, and underscores, not starting with a digit. */
  key: string;
  value: string;
  /** A note about what the secret is for. */
  description?: string;
}

/**
 * The safe view of a secret: its key, note, a masked hint, and where it is
 * bound. Never the value. One secret per key per account, so setting a key
 * changes its value everywhere it is bound.
 */
export interface Secret {
  id: string;
  key: string;
  description: string | null;
  /** A hint showing at most the last four characters, never the whole value. */
  masked: string;
  /** Servers the secret is bound to server-wide, so every project on them sees it. */
  serverIds: string[];
  /** Projects the secret is bound to on their own. */
  projectIds: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Where a project's workspace came from. "duplicate" and "import" are only
 * ever read back: the platform sets them when it copies or imports a project.
 */
export type ProjectSourceKind = "blank" | "template" | "git" | "archive" | "duplicate" | "import";

/** Where to seed a new project's workspace from. */
export type ProjectSourceInput =
  | { kind: "blank" }
  /** A template id from `templates.list()`. */
  | { kind: "template"; template: string }
  | {
      kind: "git";
      gitUrl: string;
      /** Branch, tag, or commit. Defaults to the repo's default branch. */
      ref?: string;
      /** Treat this subdirectory of the repo as the project root. */
      subdir?: string;
      /** Name of a secret holding a clone token, for a private repo. */
      authSecret?: string;
    }
  | {
      kind: "archive";
      /** Workspace path of an uploaded .zip or .tar.gz (write it with `files.write()` first). */
      archivePath: string;
    };

/** Where a project's workspace was seeded from. */
export interface ProjectSource {
  kind: ProjectSourceKind;
  template?: string;
  gitUrl?: string;
  ref?: string;
  subdir?: string;
  authSecret?: string;
  archivePath?: string;
  /** The project this one was duplicated from (kind "duplicate"). */
  sourceProjectId?: string;
  /** The deployment an imported project was exported from (kind "import"). */
  origin?: string;
}

/**
 * How bring-up installs and starts a project. A `port` of null means it is
 * not a server (a library, a CLI, a batch job), so bring-up installs it and
 * stops instead of trying to serve it.
 */
export interface RunPlan {
  /** Human-readable stack, e.g. "Node 20 / Next.js". */
  stack: string;
  install: string;
  /** Empty for something that is not started. */
  start: string;
  port: number | null;
  /** Names of the environment variables it reads. */
  env: string[];
  notes?: string;
}

/** What `project.start()` reported. */
export interface StartAppResult {
  projectId: string;
  /** The process name. "web" is the one that serves the project's URL. */
  name: string;
  /**
   * "running" once the app answered on its port (or straight away for a
   * process that serves nothing); "starting" when it had not answered yet.
   */
  status: "running" | "starting";
  listening: boolean;
  listenPort: number | null;
  /** The project's URL, or null while it is private. */
  url: string | null;
  visibility: ProjectVisibility;
  access: ProjectAccess;
  /** True when a process of the same name was stopped to make way for this one. */
  replacedPrevious: boolean;
  /** What a server restart runs to bring the process back. */
  restartCommand: string;
  logTail: string | null;
}

/** The account a key acts on, its spend, and what it holds. From `client.me()`. */
export interface AccountSummary {
  account: {
    name: string | null;
    email: string | null;
    /** The plan id, e.g. "free", "starter", "pro". */
    plan: string;
  };
  /**
   * The person holding the key, when that is a teammate rather than the
   * account owner. Null for the owner's own keys.
   */
  you: { name: string | null; email: string | null } | null;
  usage: {
    /** Spend this billing period. */
    spendUsd: number;
    includedCreditsUsd: number;
    /** Your own budget cap, or null when none is set. */
    budgetCapUsd: number | null;
    /** Remaining one-time welcome credit, 0 if none. */
    bonusUsd: number;
    /** The ceiling that pauses new tasks (your cap or the plan's credits), or null if none. */
    hardLimitUsd: number | null;
    overageAllowed: boolean;
    /** True when new tasks are blocked right now; `reason` says which ceiling. */
    blocked: boolean;
    reason: "budget_cap" | "credits_exhausted" | null;
  };
  /** The key this request was made with. */
  authenticatedKey: { id: string; label: string };
  /** How many servers, projects and API keys the account has. */
  servers: number;
  projects: number;
  keys: number;
}

/** What `init()` dispatched. */
export interface ProjectInitResult {
  /** The bring-up run, a task on the project's server. Null when none was dispatched. */
  initRunId: string | null;
  initPhase: ProjectInitPhase | null;
}

/** A portable bundle of a project, from `export()`. */
export interface ProjectExport {
  projectId: string;
  /** A time-limited download link. It needs no credentials, so treat it as the code itself. */
  url: string;
  expiresAt: string;
  filename: string;
  /** Size of the bundle. */
  bytes: number;
  /**
   * Names of the environment variables the project reads. The bundle carries
   * names only, never values, so whoever imports it supplies the values.
   */
  env: string[];
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
  /**
   * Set on import templates, which seed a project from your own code ("git"
   * or "archive") instead of a starter. Null for ordinary starters, and from
   * an API that predates the field.
   */
  sourceKind: "git" | "archive" | null;
  defaults: {
    name: string;
    description: string;
    visibility: ProjectVisibility;
    lifecycle: ProjectLifecycle;
  };
}

export interface ApiKey {
  id: string;
  label: string;
  /** Masked display form, e.g. "sk_live_abc···wxyz". Never the full secret. */
  masked: string;
  allowedServerIds: string[];
  allowedProjectIds: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** Only present once, in the response to `keys.create()`. */
export interface CreatedApiKey extends ApiKey {
  /** The plaintext sk_live_ key. Store it now: it can't be retrieved again. */
  key: string;
}

export const WEBHOOK_EVENTS = [
  "task.created",
  "task.completed",
  "task.failed",
  "deployment.live",
  "deployment.removed",
  "server.created",
  "server.stopped",
  "server.deleted",
  "quota.threshold",
  "quota.cap_reached",
  "quota.egress_cap_reached",
  "tuning.started",
  "tuning.completed",
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  createdAt: string;
}

/** Only present once, in the response to `webhooks.create()`. */
export interface CreatedWebhook extends Webhook {
  /** The signing secret (whsec_...). Store it now: it can't be retrieved again. */
  secret: string;
}

/** What a tuning run that built its own project stood up. */
export interface TuningBuild {
  /** The new project the agent's code was built into. */
  projectId: string;
  /** Where the code came from, as the evaluation platform named it. */
  source: {
    kind: "git" | "archive";
    repoUrl?: string;
    ref?: string;
    subdir?: string;
    /** The secret on this account holding a clone token, for a private repository. */
    cloneTokenSecretName?: string;
    archiveUrl?: string;
  };
  /** Environment variables the agent needs, by name. Their values come from this account's secrets. */
  envKeys: string[];
}

/** Options for starting a tuning run. Pass `projectId` or `serverId`. */
export interface StartTuningOptions {
  /** The improvement proposal id on the evaluation platform. */
  proposalId: string;
  /** The project already holding the agent's code. The fix happens in it. */
  projectId?: string;
  /**
   * Build the agent's code into a new project on this server instead, when it
   * is not here yet. The fix starts once bring-up finishes.
   */
  serverId?: string;
  /** Base URL of the evaluation API. HTTPS only. Account-wide keys only. */
  evaluationApiBase?: string;
  /**
   * Name of the secret holding the evaluation API key. Defaults to
   * AGENTX_API_KEY. Account-wide keys only.
   */
  keySecret?: string;
}

/** Your own account of a tuning run's fix, sent to the evaluation platform. */
export interface TuningReport {
  /** What changed and why, written for someone who has not seen the diff. */
  changeSummary?: string;
  changedFiles?: string[];
  /** Where the fixed agent is reachable, if it is deployed somewhere. */
  deploymentUrl?: string;
  /** Set when the issues could not be fixed, so the run closes as failed. */
  failed?: boolean;
}

/** Options accepted when creating a project. */
export interface CreateProjectOptions {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  /** Defaults to "public". Only meaningful once visibility is "public". */
  access?: ProjectAccess;
  lifecycle?: ProjectLifecycle;
  /**
   * Template id from `templates.list()`, e.g. "flight-watcher". Shorthand for
   * `source: { kind: "template", template }`, and ignored when `source` is set.
   */
  template?: string;
  /** Where to seed the workspace from. Omit for a blank project. */
  source?: ProjectSourceInput;
  /**
   * Start bring-up (seed, install, start, healthcheck) straight away. Defaults
   * to true for a git or archive source, false otherwise. The handle's
   * `initRunId` is the run it started.
   */
  autoInit?: boolean;
  /** Environment variables only this project's runs see, set and bound on create. */
  secrets?: SecretInput[];
}

/** Fields accepted when updating a project. Omitted fields are left as they are. */
export interface UpdateProjectOptions {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  access?: ProjectAccess;
  lifecycle?: ProjectLifecycle;
  /**
   * Replace the stored run plan wholesale, so send every field you want kept.
   * It is recorded for the next bring-up rather than acted on: `init()` asks
   * for the rebuild. Needs `install` or `start`.
   */
  runPlan?: Partial<RunPlan>;
}

/** Options accepted when constructing the client. */
export interface Server4AgentOptions {
  /** Your sk_live_ API key. Defaults to the SERVER4AGENT_API_KEY env var. */
  apiKey?: string;
  /** Override the API host. Defaults to https://api.server4agent.com. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 60000. */
  timeoutMs?: number;
  /** Retries for retryable failures (429/5xx/network). Default 2. */
  maxRetries?: number;
  /** Injectable fetch implementation (tests, custom runtimes). */
  fetch?: typeof fetch;
}
