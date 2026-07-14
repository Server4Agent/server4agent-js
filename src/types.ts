export type ServerTier = "small" | "medium" | "large";
export type ServerStatus = "running" | "sleeping" | "building";
export type ServerAction = "start" | "stop" | "restart";
export type ProjectVisibility = "public" | "private";
export type ProjectLifecycle = "persistent" | "ephemeral";
export type ProjectRuntimeStatus = "unbuilt" | "running" | "paused";
export type TaskStatus = "running" | "completed" | "failed" | "awaiting_input" | "cancelled";
export type BuildStatus = "queued" | "running" | "completed";
export type BuildStepStatus = "pending" | "running" | "done";

/** A task poll stops here: nothing further happens without you, or it's over. */
export const TASK_TERMINAL_STATES: readonly TaskStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "awaiting_input",
];
export const BUILD_TERMINAL_STATES: readonly BuildStatus[] = ["completed"];

export interface BuildStep {
  key: string;
  label: string;
  status: BuildStepStatus;
}

export interface Deployment {
  url: string;
  live: boolean;
}

export interface ProjectTemplate {
  id: string;
  label: string;
  description: string;
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
  /** The plaintext sk_live_ key. Store it now — it can't be retrieved again. */
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
  /** The signing secret (whsec_...). Store it now — it can't be retrieved again. */
  secret: string;
}

/** Options accepted when creating a project. */
export interface CreateProjectOptions {
  name?: string;
  description?: string;
  visibility?: ProjectVisibility;
  lifecycle?: ProjectLifecycle;
  /** Template id from `templates.list()`, e.g. "flight-watcher". */
  template?: string;
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
