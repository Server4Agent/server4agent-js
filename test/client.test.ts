import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Server4Agent,
  Server,
  Project,
  Task,
  TuningSession,
  Server4AgentError,
  APIStatusError,
  ConflictError,
  NotFoundError,
  WEBHOOK_EVENTS,
} from "../src/index.js";

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("Server4Agent client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requires an API key", () => {
    expect(() => new Server4Agent({ apiKey: "" })).toThrow(/no API key/);
  });

  // A browser box is only distinguishable from a headless one by `kind`.
  it("round-trips a server's kind, and defaults an older API's silence to standard", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "srv_1", url: null, status: "running", tier: "medium", kind: "browser" }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.create({ tier: "medium", kind: "browser" });
    expect(server.kind).toBe("browser");
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ tier: "medium", kind: "browser" });

    fetchMock.mockResolvedValue(
      jsonResponse({ servers: [{ id: "srv_2", tier: "small", status: "running" }] }),
    );
    const [older] = await client.servers.list();
    expect(older.kind).toBe("standard");
  });

  it("returns a Server handle and sends the bearer token, UA, and JSON body", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "srv_1", url: null, status: "running", tier: "small" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.create({ task: "worker" });

    expect(server).toBeInstanceOf(Server);
    expect(server.id).toBe("srv_1");
    expect(server.publicUrl).toBeNull();
    expect(server.tier).toBe("small");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.server4agent.com/servers");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk_live_test");
    expect(headers["User-Agent"]).toMatch(/^server4agent-js\//);
    expect(JSON.parse(init.body as string)).toEqual({ task: "worker" });
  });

  it("normalizes snake_case project fields to camelCase", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "proj_1",
        server_id: "srv_1",
        name: "Landing page",
        slug: "landing-page-abc",
        description: null,
        visibility: "public",
        lifecycle: "persistent",
        runtime_status: "running",
        template: null,
        url: "https://landing-page-abc.apps.server4agent.com",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
      }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const project = await client.projects.create("srv_1", { name: "Landing page", visibility: "public" });

    expect(project.serverId).toBe("srv_1");
    expect(project.runtimeStatus).toBe("running");
    expect(project.createdAt).toBe("2026-01-01T00:00:00Z");
  });

  it("builds a query string for reading a file", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ path: "app.py", content: "print(1)" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const content = await client.files.read("srv_1", "app.py");

    expect(content).toBe("print(1)");
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.server4agent.com/servers/srv_1/files?path=app.py");
  });

  it("writes binary content as base64 with encoding set, and reads it back decoded", async () => {
    const client = new Server4Agent({ apiKey: "sk_live_test" });
    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

    fetchMock.mockResolvedValueOnce(jsonResponse({ path: "book.xlsx", written: true }));
    await client.files.write("srv_1", "book.xlsx", bytes);
    const [, writeInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(writeInit.body as string)).toEqual({
      path: "book.xlsx",
      content: Buffer.from(bytes).toString("base64"),
      encoding: "base64",
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({ path: "book.xlsx", content: Buffer.from(bytes).toString("base64") }),
    );
    const read = await client.files.readBinary("srv_1", "book.xlsx");
    expect(read).toEqual(Buffer.from(bytes));
    const [readUrl] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(readUrl.toString()).toBe(
      "https://api.server4agent.com/servers/srv_1/files?path=book.xlsx&encoding=base64",
    );
  });

  it("mints a download link", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ path: "book.xlsx", url: "https://server4agent.com/api/files/v1.abc.def", expires_at: "2026-07-20T00:00:00Z" }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const link = await client.files.getDownloadUrl("srv_1", "book.xlsx", { ttlSeconds: 3600 });

    expect(link).toEqual({ url: "https://server4agent.com/api/files/v1.abc.def", expiresAt: "2026-07-20T00:00:00Z" });
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe(
      "https://api.server4agent.com/servers/srv_1/files/download-url?path=book.xlsx&ttl_seconds=3600",
    );
  });

  it("respects a custom baseUrl", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [] }));
    const client = new Server4Agent({ apiKey: "sk_live_test", baseUrl: "http://localhost:3000/api" });

    await client.files.list("srv_1");

    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("http://localhost:3000/api/servers/srv_1/files");
  });

  it("maps a status to a typed error subclass with the request id", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: "not_found", message: "server not found" }, 404, { "x-request-id": "req_abc" }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const err = await client.servers.get("srv_missing").catch((e) => e);
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err).toBeInstanceOf(Server4AgentError);
    expect(err).toMatchObject({ status: 404, code: "not_found", message: "server not found", requestId: "req_abc" });
  });

  it("retries a retryable status then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable", message: "later" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({ server: { id: "srv_1", task: "w", tier: "small", status: "running", region: "us" } }),
      );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.get("srv_1");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(server.id).toBe("srv_1");
  });

  it("does not retry a non-retryable status", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "bad_request", message: "nope" }, 400));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    await expect(client.servers.get("srv_1")).rejects.toBeInstanceOf(APIStatusError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("server.exec resolves to stdout", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ server: { id: "srv_1", task: "w", tier: "small", status: "running", region: "us" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ stdout: "hello\n" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.get("srv_1");
    expect(await server.exec("echo hello")).toBe("hello\n");
  });

  it("task.wait() polls until a terminal state", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: "tsk_1", status: "running" }))
      .mockResolvedValueOnce(
        jsonResponse({ task: { id: "tsk_1", serverId: "srv_1", goal: "x", status: "completed", createdAt: "" } }),
      );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const task = await client.tasks.create("srv_1", "do x");
    expect(task.status).toBe("running");
    const done = await task.wait({ pollIntervalMs: 0 });
    expect(done.status).toBe("completed");
  });

  it("reports who started a task, defaulting to the caller", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        tasks: [
          { id: "tsk_1", serverId: "srv_1", goal: "do x", messageType: "user", status: "completed", createdAt: "" },
          {
            id: "tsk_2",
            serverId: "srv_1",
            goal: "Project setup: import the code and start the app",
            messageType: "system",
            status: "completed",
            createdAt: "",
          },
          // An API that predates the field: what it returned was always yours.
          { id: "tsk_3", serverId: "srv_1", goal: "do y", status: "completed", createdAt: "" },
        ],
      }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const tasks = await client.tasks.list("srv_1");
    expect(tasks.map((t) => t.messageType)).toEqual(["user", "system", "user"]);
  });

  it("marks a task you create as your own message", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ task_id: "tsk_1", status: "running" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    expect((await client.tasks.create("srv_1", "do x")).messageType).toBe("user");
  });

  it("does not retry POST on 5xx", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: "boom", message: "server error" }, 500));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    await expect(client.servers.create({ tier: "small" })).rejects.toBeInstanceOf(APIStatusError);
    expect(fetchMock).toHaveBeenCalledTimes(1); // must not double-create
  });

  it("retries POST on 503", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "unavailable", message: "later" }, 503))
      .mockResolvedValueOnce(jsonResponse({ id: "srv_1", url: null, status: "running", tier: "small" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.create({ tier: "small" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(server.id).toBe("srv_1");
  });

  it("tolerates a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Bad Request</html>", { status: 400 }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const err = await client.servers.get("srv_1").catch((e) => e);
    expect(err).toBeInstanceOf(APIStatusError);
    expect(err.status).toBe(400); // no raw SyntaxError leaks
  });

  it("keeps internals off the handle (clean console.log / JSON)", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: "srv_1", url: null, status: "running", tier: "small" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.create({ tier: "small" });
    expect(Object.keys(server)).not.toContain("http");
    expect(JSON.parse(JSON.stringify(server)).http).toBeUndefined();
    expect(server.id).toBe("srv_1"); // data still there
  });

  it("percent-encodes dynamic path segments (no path injection)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ server: { id: "x", task: "w", tier: "small", status: "running", region: "us" } }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    await client.servers.get("a/b?c#d"); // a hostile id must not escape its segment
    const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe("/servers/a%2Fb%3Fc%23d");
    expect(url.pathname).not.toContain("a/b");
    expect(url.search).toBe(""); // the "?c" did not become a query string
  });

  it("never leaks the API key when the client is logged or serialized", () => {
    const client = new Server4Agent({ apiKey: "sk_live_SUPERSECRET" });
    expect(JSON.stringify(client)).not.toContain("SUPERSECRET");
    // resources hold the transport, but its fields are #private → not enumerable
    expect(JSON.stringify((client as unknown as { servers: unknown }).servers)).not.toContain("SUPERSECRET");
  });

  it("keys.create returns the plaintext key once", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        id: "key_1", label: "ci", masked: "sk_live_ab...yz",
        allowed_server_ids: [], allowed_project_ids: [],
        created_at: "t", last_used_at: null, key: "sk_live_plain",
      }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const k = await client.keys.create("ci");
    expect(k.key).toBe("sk_live_plain");
    expect(k.allowedServerIds).toEqual([]);
  });

  it("webhooks.create returns the signing secret once", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "wh_1", url: "https://x.example/hook", events: ["task.completed"], created_at: "t", secret: "whsec_abc" }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const w = await client.webhooks.create("https://x.example/hook", ["task.completed"]);
    expect(w.secret).toBe("whsec_abc");
    expect(w.events).toEqual(["task.completed"]);
  });

  it("templates.list returns typed templates", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        templates: [{ id: "t1", label: "Flight watcher", description: "d", defaults: { name: "n", description: "d", visibility: "public", lifecycle: "persistent" } }],
      }),
    );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const ts = await client.templates.list();
    expect(ts[0].defaults.visibility).toBe("public");
  });

  it("files.write sends a PUT with the body", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    await client.files.write("srv_1", "app.py", "print(1)");
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(init.method).toBe("PUT");
    expect(url.pathname).toBe("/servers/srv_1/files");
    expect(JSON.parse(init.body as string)).toEqual({ path: "app.py", content: "print(1)" });
  });

  it("scoped sub-resource: server.tasks.create posts under the server", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ server: { id: "srv_1", task: "w", tier: "small", status: "running", region: "us" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ task_id: "tsk_1", status: "running" }));
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const server = await client.servers.get("srv_1");
    const task = await server.tasks.create("do x");
    expect(task.id).toBe("tsk_1");
    const [url] = fetchMock.mock.calls[1] as [URL, RequestInit];
    expect(url.pathname).toBe("/servers/srv_1/tasks");
  });

  it("wait() reports progress via onProgress", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ task_id: "tsk_1", status: "running" }))
      .mockResolvedValueOnce(
        jsonResponse({ task: { id: "tsk_1", serverId: "srv_1", goal: "x", status: "completed", createdAt: "" } }),
      );
    const client = new Server4Agent({ apiKey: "sk_live_test" });

    const task = await client.tasks.create("srv_1", "do x");
    const seen: string[] = [];
    await task.wait({ pollIntervalMs: 0, onProgress: (t) => seen.push(t.status) });
    expect(seen).toEqual(["completed"]);
  });
});

// --- the rest of the REST surface --------------------------------------------

function projectRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "proj_1",
    server_id: "srv_1",
    name: "Landing page",
    slug: "landing-page-abc",
    description: null,
    visibility: "private",
    access: "public",
    lifecycle: "persistent",
    runtime_status: "running",
    init_phase: null,
    template: null,
    url: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function secretRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "sec_1",
    key: "OPENAI_KEY",
    description: "model key",
    masked: "••••3f9a",
    server_ids: ["srv_1"],
    project_ids: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-02T00:00:00Z",
    ...overrides,
  };
}

function tuningRaw(overrides: Record<string, unknown> = {}) {
  return {
    id: "tun_1",
    serverId: "srv_1",
    projectId: "proj_1",
    runId: "tsk_9",
    buildRunId: null,
    proposalId: "prop_1",
    evaluationApiBase: "https://evals.northstar.example",
    keySecretKey: "EVAL_KEY",
    briefPath: ".tuning/brief.md",
    briefRevision: "r1",
    status: "fixing",
    changeSummary: null,
    changedFiles: [],
    deploymentUrl: null,
    reportedAt: null,
    reportError: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function runRaw(overrides: Record<string, unknown> = {}) {
  return {
    run_id: "tsk_9",
    server_id: "srv_1",
    project_id: "proj_1",
    goal: "Fix the failing cases",
    message_type: "system",
    status: "running",
    created_at: "2026-01-01T00:00:00Z",
    log: null,
    result: null,
    question: null,
    change: null,
    usage: null,
    ...overrides,
  };
}

const HOSTILE = "a/b?c#d";
const HOSTILE_SEG = "a%2Fb%3Fc%23d";

describe("REST coverage", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: Server4Agent;

  function call(i: number): { url: URL; method: string; body: unknown } {
    const [url, init] = fetchMock.mock.calls[i] as [URL, RequestInit];
    return {
      url,
      method: init.method ?? "GET",
      body: init.body !== undefined ? JSON.parse(init.body as string) : undefined,
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new Server4Agent({ apiKey: "sk_live_test", maxRetries: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Answer every call with a fresh copy of the same body (a Response body reads once). */
  function answerAlways(body: unknown, status = 200) {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(body, status)));
  }

  async function serverHandle(id = "srv_1") {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ server: { id, task: "w", tier: "small", status: "running", region: "us-east" } }),
    );
    return client.servers.get(id);
  }

  async function projectHandle(overrides: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectRaw(overrides)));
    return client.projects.get((overrides.id as string) ?? "proj_1");
  }

  describe("secrets", () => {
    it("secrets.list maps the safe view to camelCase and never carries a value", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ secrets: [secretRaw()] }));

      const [s] = await client.secrets.list();

      expect(call(0).url.pathname).toBe("/secrets");
      expect(call(0).method).toBe("GET");
      expect(s).toEqual({
        id: "sec_1",
        key: "OPENAI_KEY",
        description: "model key",
        masked: "••••3f9a",
        serverIds: ["srv_1"],
        projectIds: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
      });
      expect(Object.keys(s)).not.toContain("value");
    });

    it("secrets.set PUTs one secret and returns its safe view", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(secretRaw({ server_ids: [] })));

      const s = await client.secrets.set({ key: "OPENAI_KEY", value: "sk-123", description: "model key" });

      expect(call(0).method).toBe("PUT");
      expect(call(0).url.pathname).toBe("/secrets");
      expect(call(0).body).toEqual({ key: "OPENAI_KEY", value: "sk-123", description: "model key" });
      expect(s.serverIds).toEqual([]);
    });

    it("secrets.delete escapes the id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ id: HOSTILE, deleted: true }));

      await client.secrets.delete(HOSTILE);

      expect(call(0).method).toBe("DELETE");
      expect(call(0).url.pathname).toBe(`/secrets/${HOSTILE_SEG}`);
      expect(call(0).url.search).toBe("");
    });

    it("server.secrets lists and sets under the server", async () => {
      const server = await serverHandle();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ secrets: [secretRaw()] }))
        .mockResolvedValueOnce(jsonResponse({ secrets: [secretRaw(), secretRaw({ id: "sec_2", key: "DB_URL" })] }));

      expect((await server.secrets.list()).map((s) => s.key)).toEqual(["OPENAI_KEY"]);
      const after = await server.secrets.set([{ key: "DB_URL", value: "postgres://x" }]);

      expect(call(1).url.pathname).toBe("/servers/srv_1/secrets");
      expect(call(2).method).toBe("PUT");
      expect(call(2).url.pathname).toBe("/servers/srv_1/secrets");
      expect(call(2).body).toEqual({ secrets: [{ key: "DB_URL", value: "postgres://x" }] });
      expect(after.map((s) => s.key)).toEqual(["OPENAI_KEY", "DB_URL"]);
    });

    it("project.secrets lists and sets under the project", async () => {
      const project = await projectHandle();
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ secrets: [] }))
        .mockResolvedValueOnce(
          jsonResponse({ secrets: [secretRaw({ key: "STRIPE_KEY", server_ids: [], project_ids: ["proj_1"] })] }),
        );

      expect(await project.secrets.list()).toEqual([]);
      const after = await project.secrets.set([{ key: "STRIPE_KEY", value: "rk_1", description: "billing" }]);

      expect(call(1).url.pathname).toBe("/projects/proj_1/secrets");
      expect(call(2).method).toBe("PUT");
      expect(call(2).body).toEqual({ secrets: [{ key: "STRIPE_KEY", value: "rk_1", description: "billing" }] });
      expect(after[0].projectIds).toEqual(["proj_1"]);
    });

    it("flat scoped secrets escape server and project ids", async () => {
      answerAlways({ secrets: [] });

      await client.secrets.listForServer(HOSTILE);
      await client.secrets.setForServer(HOSTILE, [{ key: "A", value: "1" }]);
      await client.secrets.listForProject(HOSTILE);
      await client.secrets.setForProject(HOSTILE, [{ key: "B", value: "2" }]);

      expect(call(0).url.pathname).toBe(`/servers/${HOSTILE_SEG}/secrets`);
      expect(call(1).url.pathname).toBe(`/servers/${HOSTILE_SEG}/secrets`);
      expect(call(1).method).toBe("PUT");
      expect(call(2).url.pathname).toBe(`/projects/${HOSTILE_SEG}/secrets`);
      expect(call(3).url.pathname).toBe(`/projects/${HOSTILE_SEG}/secrets`);
      expect(call(3).body).toEqual({ secrets: [{ key: "B", value: "2" }] });
    });

    it("servers.create and projects.create pass inline secrets through", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ id: "srv_1", url: null, status: "running", tier: "small" }))
        .mockResolvedValueOnce(jsonResponse(projectRaw()));

      await client.servers.create({ tier: "small", secrets: [{ key: "A", value: "1" }] });
      await client.projects.create("srv_1", { name: "x", secrets: [{ key: "B", value: "2" }] });

      expect(call(0).body).toEqual({ tier: "small", secrets: [{ key: "A", value: "1" }] });
      expect(call(1).body).toEqual({ name: "x", secrets: [{ key: "B", value: "2" }] });
    });
  });

  describe("logs", () => {
    const snapshot = {
      updatedAt: "2026-10-11T03:45:45.000Z",
      files: [
        {
          path: "landing-page-abc/server.log",
          projectSlug: "landing-page-abc",
          name: "server.log",
          sizeBytes: 2048,
          modifiedAt: "2026-10-11T03:45:00.000Z",
          tail: "listening on 3000\n",
        },
      ],
    };

    it("server.logs passes project_id and lines and returns the snapshot", async () => {
      const server = await serverHandle();
      fetchMock.mockResolvedValueOnce(jsonResponse({ logs: snapshot }));

      const logs = await server.logs({ projectId: "proj_1", lines: 50 });

      expect(call(1).url.pathname).toBe("/servers/srv_1/logs");
      expect(call(1).url.searchParams.get("project_id")).toBe("proj_1");
      expect(call(1).url.searchParams.get("lines")).toBe("50");
      expect(logs).toEqual(snapshot);
    });

    it("resolves to null before the server has reported any logs, and sends no empty params", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ logs: null }));

      expect(await client.servers.logs("srv_1")).toBeNull();
      expect(call(0).url.search).toBe("");
    });

    it("project.logs reads its server's logs narrowed to itself", async () => {
      const project = await projectHandle({ server_id: "srv_7" });
      fetchMock.mockResolvedValueOnce(jsonResponse({ logs: snapshot }));

      await project.logs({ lines: 10 });

      expect(call(1).url.pathname).toBe("/servers/srv_7/logs");
      expect(call(1).url.searchParams.get("project_id")).toBe("proj_1");
      expect(call(1).url.searchParams.get("lines")).toBe("10");
    });

    it("servers.logs escapes the server id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ logs: null }));

      await client.servers.logs(HOSTILE, { projectId: "x&y=z" });

      expect(call(0).url.pathname).toBe(`/servers/${HOSTILE_SEG}/logs`);
      expect(call(0).url.searchParams.get("project_id")).toBe("x&y=z");
      expect(call(0).url.search).toBe("?project_id=x%26y%3Dz");
    });
  });

  describe("project bring-up, export and import", () => {
    it("reads initPhase off a project, and defaults an older API's silence to null", async () => {
      const seeding = await projectHandle({ init_phase: "awaiting_secrets" });
      expect(seeding.initPhase).toBe("awaiting_secrets");

      const raw = projectRaw();
      delete (raw as Record<string, unknown>).init_phase;
      fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [raw] }));
      const [older] = await client.projects.list();
      expect(older.initPhase).toBeNull();
    });

    it("project.init POSTs proceed and maps the run", async () => {
      const project = await projectHandle();
      fetchMock.mockResolvedValueOnce(jsonResponse({ init_run_id: "tsk_5", init_phase: "installing" }, 201));

      const r = await project.init({ proceed: true });

      expect(call(1).method).toBe("POST");
      expect(call(1).url.pathname).toBe("/projects/proj_1/init");
      expect(call(1).body).toEqual({ proceed: true });
      expect(r).toEqual({ initRunId: "tsk_5", initPhase: "installing" });
    });

    it("projects.init escapes the id and sends an empty body without options", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ init_run_id: null, init_phase: null }, 201));

      const r = await client.projects.init(HOSTILE);

      expect(call(0).url.pathname).toBe(`/projects/${HOSTILE_SEG}/init`);
      expect(call(0).body).toEqual({});
      expect(r).toEqual({ initRunId: null, initPhase: null });
    });

    it("project.export POSTs ttl_seconds and maps the bundle", async () => {
      const project = await projectHandle();
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          {
            project_id: "proj_1",
            url: "https://server4agent.com/api/files/v1.abc.def",
            expires_at: "2026-10-12T00:00:00Z",
            filename: "landing-page-abc.s4a.tar.gz",
            bytes: 18342,
            env: ["DATABASE_URL", "STRIPE_KEY"],
          },
          201,
        ),
      );

      const bundle = await project.export({ ttlSeconds: 3600 });

      expect(call(1).method).toBe("POST");
      expect(call(1).url.pathname).toBe("/projects/proj_1/export");
      expect(call(1).body).toEqual({ ttl_seconds: 3600 });
      expect(bundle).toEqual({
        projectId: "proj_1",
        url: "https://server4agent.com/api/files/v1.abc.def",
        expiresAt: "2026-10-12T00:00:00Z",
        filename: "landing-page-abc.s4a.tar.gz",
        bytes: 18342,
        env: ["DATABASE_URL", "STRIPE_KEY"],
      });
    });

    it("projects.export escapes the id", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ project_id: "x", url: "u", expires_at: "t", filename: "f", bytes: 1, env: [] }, 201),
      );

      await client.projects.export(HOSTILE);

      expect(call(0).url.pathname).toBe(`/projects/${HOSTILE_SEG}/export`);
      expect(call(0).body).toEqual({});
    });

    const importedRaw = {
      ...projectRaw({ id: "proj_2", name: "Imported", init_phase: "seeding" }),
      init_run_id: "tsk_7",
      imported_from: "https://other.northstar.example",
      exported_at: "2026-10-01T00:00:00Z",
      bound_env: ["DATABASE_URL"],
      missing_env: ["STRIPE_KEY"],
      warnings: ["The bundle asked for team access, which this deployment does not offer."],
    };

    it("server.projects.import base64-encodes bytes and returns the project plus what the import reported", async () => {
      const server = await serverHandle();
      fetchMock.mockResolvedValueOnce(jsonResponse(importedRaw, 201));
      const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff]);

      const r = await server.projects.import(bytes, { name: "Imported" });

      expect(call(1).method).toBe("POST");
      expect(call(1).url.pathname).toBe("/servers/srv_1/projects/import");
      expect(call(1).body).toEqual({ bundle: Buffer.from(bytes).toString("base64"), name: "Imported" });
      expect(r.project).toBeInstanceOf(Project);
      expect(r.project.id).toBe("proj_2");
      expect(r.project.initPhase).toBe("seeding");
      expect(r).toMatchObject({
        initRunId: "tsk_7",
        importedFrom: "https://other.northstar.example",
        exportedAt: "2026-10-01T00:00:00Z",
        boundEnv: ["DATABASE_URL"],
        missingEnv: ["STRIPE_KEY"],
        warnings: ["The bundle asked for team access, which this deployment does not offer."],
      });
    });

    it("accepts a Buffer, and a base64 string as-is, minus line wrapping", async () => {
      answerAlways(importedRaw, 201);

      await client.projects.import("srv_1", Buffer.from("bundle bytes"));
      await client.projects.import("srv_1", "YnVuZGxl\nIGJ5dGVz\n");

      expect(call(0).body).toEqual({ bundle: Buffer.from("bundle bytes").toString("base64") });
      expect(call(1).body).toEqual({ bundle: "YnVuZGxlIGJ5dGVz" });
    });

    it("projects.import escapes the server id and tolerates an older answer", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ...projectRaw({ id: "proj_3" }), exported_at: "2026-10-01T00:00:00Z" }, 201),
      );

      const r = await client.projects.import(HOSTILE, "AAAA");

      expect(call(0).url.pathname).toBe(`/servers/${HOSTILE_SEG}/projects/import`);
      expect(r).toMatchObject({ initRunId: null, importedFrom: null, boundEnv: [], missingEnv: [], warnings: [] });
    });
  });

  describe("deploy", () => {
    it("server.deploy names the project and still resolves to the URL", async () => {
      const server = await serverHandle();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ url: "https://landing-page-abc.apps.server4agent.com", status: "publishing", project_id: "proj_1" }, 201),
      );

      const url = await server.deploy({ projectId: "proj_1" });

      expect(call(1).method).toBe("POST");
      expect(call(1).url.pathname).toBe("/servers/srv_1/deployments");
      expect(call(1).body).toEqual({ project_id: "proj_1" });
      expect(url).toBe("https://landing-page-abc.apps.server4agent.com");
    });

    it("lets the API pick the only project when none is named", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ url: "https://x.apps.server4agent.com", status: "live", project_id: "proj_9" }, 201));

      const url = await client.servers.deploy(HOSTILE);

      expect(call(0).url.pathname).toBe(`/servers/${HOSTILE_SEG}/deployments`);
      expect(call(0).body).toEqual({});
      expect(url).toBe("https://x.apps.server4agent.com");
    });

    it("project.deploy deploys itself on its own server and says whether it answered", async () => {
      const project = await projectHandle({ server_id: "srv_7" });
      fetchMock.mockResolvedValueOnce(jsonResponse({ url: "https://x.apps.server4agent.com", status: "live", project_id: "proj_1" }, 201));

      const r = await project.deploy();

      expect(call(1).url.pathname).toBe("/servers/srv_7/deployments");
      expect(call(1).body).toEqual({ project_id: "proj_1" });
      expect(r).toEqual({ url: "https://x.apps.server4agent.com", status: "live", projectId: "proj_1" });
    });

    it("surfaces nothing listening as a ConflictError", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: "not_listening", message: "Nothing is listening on port 3000." }, 409),
      );

      const err = await client.servers.deploy("srv_1", { projectId: "proj_1" }).catch((e) => e);

      expect(err).toBeInstanceOf(ConflictError);
      expect(err.code).toBe("not_listening");
    });

    it("lists deployments with their project, null from an older API", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          deployments: [
            { url: "https://a.apps.server4agent.com", live: true, project_id: "proj_1" },
            { url: "https://b.apps.server4agent.com", live: false },
          ],
        }),
      );

      const ds = await client.servers.listDeployments("srv_1");

      expect(ds).toEqual([
        { url: "https://a.apps.server4agent.com", live: true, projectId: "proj_1" },
        { url: "https://b.apps.server4agent.com", live: false, projectId: null },
      ]);
    });
  });

  describe("tasks, exec and project updates", () => {
    it("tasks.create targets a project or follows up on an earlier task", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ task_id: "tsk_1", status: "running", project_id: "proj_1" }, 201))
        .mockResolvedValueOnce(
          jsonResponse(
            { task_id: "tsk_2", status: "running", project_id: "proj_1", follow_up_of: "tsk_1", resumed: true },
            201,
          ),
        );

      const t1 = await client.tasks.create("srv_1", "add a login form", { projectId: "proj_1" });
      const t2 = await client.tasks.create("srv_1", "Yes, keep the response shape.", { followUpOf: "tsk_1" });

      expect(call(0).body).toEqual({ goal: "add a login form", project_id: "proj_1" });
      expect(call(1).body).toEqual({ goal: "Yes, keep the response shape.", follow_up_of: "tsk_1" });
      expect(t1.projectId).toBe("proj_1");
      expect(t1.followUpOf).toBeUndefined();
      expect(t2.projectId).toBe("proj_1");
      expect(t2.followUpOf).toBe("tsk_1");
      expect(t2.resumed).toBe(true);
    });

    it("keeps a task's progress note, what it changed, and what it cost", async () => {
      const change = { commit: "abc123", branch: "task/login-1a2b", filesChanged: 2, insertions: 40, deletions: 3, files: ["app.py", "login.html"] };
      const usage = { cost: 0.42, inputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 6, durationMs: 54000, costSource: "reported" };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ task: { id: "tsk_1", serverId: "srv_1", projectId: null, goal: "x", status: "completed", createdAt: "", log: "done", change, usage } }),
      );

      const t = await client.tasks.get("srv_1", "tsk_1");

      expect(t.log).toBe("done");
      expect(t.change).toEqual(change);
      expect(t.usage).toEqual(usage);
    });

    it("reads a task's project, null at the server root or from an older API", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          tasks: [
            { id: "tsk_1", serverId: "srv_1", projectId: "proj_1", goal: "x", status: "completed", createdAt: "" },
            { id: "tsk_2", serverId: "srv_1", projectId: null, goal: "y", status: "completed", createdAt: "" },
            { id: "tsk_3", serverId: "srv_1", goal: "z", status: "completed", createdAt: "" },
          ],
        }),
      );

      const tasks = await client.tasks.list("srv_1");
      expect(tasks.map((t) => t.projectId)).toEqual(["proj_1", null, null]);
    });

    it("exec runs inside a project's folder when asked", async () => {
      const server = await serverHandle();
      answerAlways({ stdout: "ok\n" });

      await server.exec("ls", { projectId: "proj_1" });
      await client.servers.exec("srv_1", "pwd");

      expect(call(1).body).toEqual({ command: "ls", project_id: "proj_1" });
      expect(call(2).body).toEqual({ command: "pwd" });
    });

    it("projects.update sends access, like project.update does", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(projectRaw({ access: "team" })));

      const p = await client.projects.update(HOSTILE, { access: "team" });

      expect(call(0).method).toBe("PATCH");
      expect(call(0).url.pathname).toBe(`/projects/${HOSTILE_SEG}`);
      expect(call(0).body).toEqual({ access: "team" });
      expect(p.access).toBe("team");
    });

    it("knows every webhook event the API accepts", () => {
      expect(WEBHOOK_EVENTS).toEqual(
        expect.arrayContaining(["quota.egress_cap_reached", "tuning.started", "tuning.completed"]),
      );
    });
  });

  describe("tuning", () => {
    it("tuning.list filters by project and status and returns handles", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [tuningRaw()] }));

      const [s] = await client.tuning.list({ projectId: "proj_1", status: "fixing" });

      expect(call(0).url.pathname).toBe("/tuning/sessions");
      expect(call(0).url.searchParams.get("project_id")).toBe("proj_1");
      expect(call(0).url.searchParams.get("status")).toBe("fixing");
      expect(s).toBeInstanceOf(TuningSession);
      expect(s).toMatchObject({ id: "tun_1", proposalId: "prop_1", runId: "tsk_9", status: "fixing", run: null });
    });

    it("tuning.start sends snake_case and says it started a run on 201", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ session: tuningRaw(), analysisReady: false, warning: "platform not told" }, 201),
      );

      const r = await client.tuning.start({
        proposalId: "prop_1",
        projectId: "proj_1",
        evaluationApiBase: "https://evals.northstar.example",
        keySecret: "EVAL_KEY",
      });

      expect(call(0).method).toBe("POST");
      expect(call(0).url.pathname).toBe("/tuning/sessions");
      expect(call(0).body).toEqual({
        proposal_id: "prop_1",
        project_id: "proj_1",
        evaluation_api_base: "https://evals.northstar.example",
        key_secret: "EVAL_KEY",
      });
      expect(r.started).toBe(true);
      expect(r.analysisReady).toBe(false);
      expect(r.warning).toBe("platform not told");
      expect(r.built).toBeNull();
      expect(r.session.id).toBe("tun_1");
    });

    it("tuning.start returns the run already under way on 200, and what a build stood up", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ session: tuningRaw(), message: "A tuning run already exists for this proposal." }),
      );
      const existing = await client.tuning.start({ proposalId: "prop_1", projectId: "proj_1" });
      expect(existing.started).toBe(false);
      expect(existing.analysisReady).toBeNull();

      const built = {
        projectId: "proj_5",
        source: { kind: "git", repoUrl: "https://git.northstar.example/agent.git", ref: "main" },
        envKeys: ["PINECONE_KEY"],
      };
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ session: tuningRaw({ status: "building", runId: null, buildRunId: "tsk_4" }), built }, 201),
      );
      const fresh = await client.tuning.start({ proposalId: "prop_2", serverId: "srv_1" });
      expect(call(1).body).toEqual({ proposal_id: "prop_2", server_id: "srv_1" });
      expect(fresh.started).toBe(true);
      expect(fresh.built).toEqual(built);
      expect(fresh.session).toMatchObject({ status: "building", runId: null, buildRunId: "tsk_4" });
    });

    it("tuning.get escapes the id and maps the run behind it to a Task", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: tuningRaw(), run: runRaw({ status: "awaiting_input", question: "Which branch?" }) }));

      const s = await client.tuning.get(HOSTILE);

      expect(call(0).url.pathname).toBe(`/tuning/sessions/${HOSTILE_SEG}`);
      expect(s.run).toBeInstanceOf(Task);
      expect(s.run).toMatchObject({
        id: "tsk_9",
        serverId: "srv_1",
        projectId: "proj_1",
        messageType: "system",
        status: "awaiting_input",
        question: "Which branch?",
      });
    });

    it("report PATCHes snake_case and updates the handle", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: tuningRaw() }));
      const s = await client.tuning.get("tun_1");
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          session: tuningRaw({ status: "reported", changeSummary: "Grounded answers in the docs", changedFiles: ["agent.py"] }),
        }),
      );

      await s.report({ changeSummary: "Grounded answers in the docs", changedFiles: ["agent.py"], failed: false });

      expect(call(1).method).toBe("PATCH");
      expect(call(1).url.pathname).toBe("/tuning/sessions/tun_1");
      expect(call(1).body).toEqual({
        change_summary: "Grounded answers in the docs",
        changed_files: ["agent.py"],
        failed: false,
      });
      expect(s.status).toBe("reported");
      expect(s.changedFiles).toEqual(["agent.py"]);
    });

    it("tuning.report escapes the id", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: tuningRaw({ status: "failed" }) }));

      const s = await client.tuning.report(HOSTILE, { failed: true });

      expect(call(0).url.pathname).toBe(`/tuning/sessions/${HOSTILE_SEG}`);
      expect(call(0).body).toEqual({ failed: true });
      expect(s.status).toBe("failed");
    });

    it("wait() reads until the outcome is reported", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ session: tuningRaw() }, 201));
      const { session } = await client.tuning.start({ proposalId: "prop_1", projectId: "proj_1" });
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ session: tuningRaw(), run: runRaw() }))
        .mockResolvedValueOnce(jsonResponse({ session: tuningRaw({ status: "reported" }), run: runRaw({ status: "completed" }) }));

      const seen: string[] = [];
      await session.wait({ pollIntervalMs: 0, onProgress: (s) => seen.push(s.status) });

      expect(seen).toEqual(["fixing", "reported"]);
      expect(session.run?.status).toBe("completed");
      expect(call(2).url.pathname).toBe("/tuning/sessions/tun_1");
    });

    it("wait() stops when the run behind it is waiting on an answer", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ sessions: [tuningRaw()] }));
      const [session] = await client.tuning.list();
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ session: tuningRaw(), run: runRaw({ status: "awaiting_input", question: "Which branch?" }) }),
      );

      await session.wait({ pollIntervalMs: 0 });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(session.status).toBe("fixing");
      expect(session.run?.question).toBe("Which branch?");
    });
  });
});

describe("REST coverage: apps, account, project sources", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: Server4Agent;

  function call(i: number): { url: URL; method: string; body: unknown } {
    const [url, init] = fetchMock.mock.calls[i] as [URL, RequestInit];
    return {
      url,
      method: init.method ?? "GET",
      body: init.body !== undefined ? JSON.parse(init.body as string) : undefined,
    };
  }

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    client = new Server4Agent({ apiKey: "sk_live_test", maxRetries: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const started = {
    project_id: "proj_1",
    name: "web",
    status: "running",
    listening: true,
    listen_port: 3000,
    url: null,
    visibility: "private",
    access: "public",
    replaced_previous: false,
    restart_command: "cd landing-page-abc && node server.js",
    log_tail: "listening on 3000",
  };

  it("project.start POSTs the command and maps what came up", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(projectRaw()));
    const project = await client.projects.get("proj_1");
    fetchMock.mockResolvedValueOnce(jsonResponse(started));

    const r = await project.start("node server.js");

    expect(call(1).method).toBe("POST");
    expect(call(1).url.pathname).toBe("/projects/proj_1/start");
    expect(call(1).body).toEqual({ command: "node server.js" });
    expect(r).toEqual({
      projectId: "proj_1",
      name: "web",
      status: "running",
      listening: true,
      listenPort: 3000,
      url: null,
      visibility: "private",
      access: "public",
      replacedPrevious: false,
      restartCommand: "cd landing-page-abc && node server.js",
      logTail: "listening on 3000",
    });
  });

  it("projects.start escapes the id and passes a process name", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...started, name: "worker", listening: false }));

    const r = await client.projects.start(HOSTILE, "python worker.py", { name: "worker" });

    expect(call(0).url.pathname).toBe(`/projects/${HOSTILE_SEG}/start`);
    expect(call(0).body).toEqual({ command: "python worker.py", name: "worker" });
    expect(r.name).toBe("worker");
  });

  it("a start that fails carries the log tail on the error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { error: "app_failed", message: "The app exited before it answered on port 3000.", log_tail: "Error: Cannot find module 'express'" },
        409,
      ),
    );

    const err = await client.projects.start("proj_1", "node server.js").catch((e) => e);

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.code).toBe("app_failed");
    expect(err.body).toMatchObject({ log_tail: "Error: Cannot find module 'express'" });
  });

  it("client.me maps the account summary, and has no `you` for the owner's own key", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        account: { name: "Northstar Labs", email: "team@northstar.example", plan: "pro" },
        usage: {
          spend_usd: 12.5,
          included_credits_usd: 50,
          budget_cap_usd: null,
          bonus_usd: 0,
          hard_limit_usd: 50,
          overage_allowed: false,
          blocked: false,
          reason: null,
        },
        authenticated_key: { id: "key_1", label: "ci" },
        servers: 2,
        projects: 5,
        keys: 3,
      }),
    );

    const me = await client.me();

    expect(call(0).url.pathname).toBe("/me");
    expect(me).toEqual({
      account: { name: "Northstar Labs", email: "team@northstar.example", plan: "pro" },
      you: null,
      usage: {
        spendUsd: 12.5,
        includedCreditsUsd: 50,
        budgetCapUsd: null,
        bonusUsd: 0,
        hardLimitUsd: 50,
        overageAllowed: false,
        blocked: false,
        reason: null,
      },
      authenticatedKey: { id: "key_1", label: "ci" },
      servers: 2,
      projects: 5,
      keys: 3,
    });
  });

  it("client.me reports the teammate holding the key", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        account: { name: "Northstar Labs", email: "team@northstar.example", plan: "business" },
        you: { name: "Ada", email: "ada@northstar.example" },
        usage: { spend_usd: 0, included_credits_usd: 200, blocked: true, reason: "budget_cap" },
        authenticated_key: { id: "key_2", label: "ada laptop" },
        servers: 0,
        projects: 0,
        keys: 1,
      }),
    );

    const me = await client.me();

    expect(me.you).toEqual({ name: "Ada", email: "ada@northstar.example" });
    expect(me.usage).toMatchObject({ blocked: true, reason: "budget_cap", budgetCapUsd: null, bonusUsd: 0 });
  });

  it("projects.create maps a git source and autoInit to snake_case, and keeps the bring-up run id", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        projectRaw({
          source: { kind: "git", git_url: "https://git.northstar.example/app.git", ref: "main", auth_secret: "GIT_TOKEN" },
          init_phase: "seeding",
          init_run_id: "tsk_3",
        }),
        201,
      ),
    );

    const p = await client.projects.create("srv_1", {
      name: "app",
      source: { kind: "git", gitUrl: "https://git.northstar.example/app.git", ref: "main", authSecret: "GIT_TOKEN" },
      autoInit: true,
    });

    expect(call(0).body).toEqual({
      name: "app",
      source: { kind: "git", git_url: "https://git.northstar.example/app.git", ref: "main", auth_secret: "GIT_TOKEN" },
      auto_init: true,
    });
    expect(p.source).toEqual({ kind: "git", gitUrl: "https://git.northstar.example/app.git", ref: "main", authSecret: "GIT_TOKEN" });
    expect(p.initPhase).toBe("seeding");
    expect(p.initRunId).toBe("tsk_3");
  });

  it("maps archive and template sources", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(projectRaw(), 201)));

    await client.projects.create("srv_1", { source: { kind: "archive", archivePath: "uploads/app.zip" }, autoInit: false });
    await client.projects.create("srv_1", { source: { kind: "template", template: "flight-watcher" } });

    expect(call(0).body).toEqual({ source: { kind: "archive", archive_path: "uploads/app.zip" }, auto_init: false });
    expect(call(1).body).toEqual({ source: { kind: "template", template: "flight-watcher" } });
  });

  it("reads a project's source, run plan and missing bring-up run", async () => {
    const plan = { stack: "Node 20 / Express", install: "npm ci", start: "node server.js", port: 3000, env: ["DATABASE_URL"] };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        projectRaw({
          source: { kind: "import", archive_path: ".imports/app.s4a", origin: "https://other.northstar.example" },
          run_plan: plan,
        }),
      ),
    );

    const p = await client.projects.get("proj_1");

    expect(p.source).toEqual({ kind: "import", archivePath: ".imports/app.s4a", origin: "https://other.northstar.example" });
    expect(p.runPlan).toEqual(plan);
    expect(p.initRunId).toBeNull();

    const older = projectRaw();
    delete (older as Record<string, unknown>).init_phase;
    fetchMock.mockResolvedValueOnce(jsonResponse({ projects: [older] }));
    const [o] = await client.projects.list();
    expect(o.source).toBeNull();
    expect(o.runPlan).toBeNull();
  });

  it("update sends a run plan as run_plan, from the handle and the flat form", async () => {
    const plan = { install: "pip install -r requirements.txt", start: "python app.py", port: 8000 };
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse(projectRaw({ run_plan: { stack: "", env: [], ...plan } }))));

    const p = await client.projects.update("proj_1", { runPlan: plan });
    await p.update({ name: "renamed", runPlan: plan });

    expect(call(0).body).toEqual({ run_plan: plan });
    expect(call(1).body).toEqual({ name: "renamed", run_plan: plan });
    expect(p.runPlan).toMatchObject(plan);
  });

  it("templates.list maps source_kind", async () => {
    const defaults = { name: "n", description: "d", visibility: "private", lifecycle: "persistent" };
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        templates: [
          { id: "git-import", label: "From a git repo", description: "d", source_kind: "git", defaults },
          { id: "flight-watcher", label: "Flight watcher", description: "d", source_kind: null, defaults },
          { id: "older", label: "Older API", description: "d", defaults },
        ],
      }),
    );

    const ts = await client.templates.list();

    expect(ts.map((t) => t.sourceKind)).toEqual(["git", null, null]);
    expect(Object.keys(ts[0])).not.toContain("source_kind");
  });

  it("maps the tuning run's change and usage to camelCase", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        session: tuningRaw({ status: "reported" }),
        run: runRaw({
          status: "completed",
          log: "done",
          change: { commit: "abc", branch: "task/fix", merge_commit: "def", files_changed: 1, insertions: 4, deletions: 2, files: ["agent.py"] },
          usage: {
            cost_usd: 0.3, input_tokens: 10, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0,
            turns: 2, duration_ms: 900, cost_source: "estimated",
          },
        }),
      }),
    );

    const s = await client.tuning.get("tun_1");

    expect(s.run?.log).toBe("done");
    expect(s.run?.change).toEqual({ commit: "abc", branch: "task/fix", mergeCommit: "def", filesChanged: 1, insertions: 4, deletions: 2, files: ["agent.py"] });
    expect(s.run?.usage).toEqual({
      cost: 0.3, inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0,
      turns: 2, durationMs: 900, costSource: "estimated",
    });
  });
});
