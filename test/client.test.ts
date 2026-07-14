import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Server4Agent,
  Server,
  Server4AgentError,
  APIStatusError,
  NotFoundError,
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
