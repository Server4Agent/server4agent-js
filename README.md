# @server4agent/sdk

JavaScript/TypeScript client for the [Server4Agent](https://www.server4agent.com)
REST API — fully typed, promise-based, with automatic retries.

This SDK is for the code *around* your agent — your backend, a CI job, a
webhook receiver, an admin script. If your agent itself does tool-calling,
point it at the [MCP server](https://www.server4agent.com/docs/mcp) directly;
it doesn't need this package.

## Install

```bash
npm install @server4agent/sdk
```

ESM, Node 18+ (uses the built-in `fetch`). Ships its own types.

## Quickstart

```ts
import { Server4Agent } from "@server4agent/sdk";

const client = new Server4Agent(); // reads SERVER4AGENT_API_KEY

// create() resolves to a handle you can act on directly
const server = await client.servers.create({ tier: "small" });

// kick off a build and await until it's live
const build = await (await server.builds.start("a FastAPI todo API with a web UI")).wait();
console.log(build.url);

// run a command right on the server
console.log(await server.exec("ls -la"));
```

`apiKey` can also be passed explicitly: `new Server4Agent({ apiKey: "sk_live_..." })`.

## Handles

`create()` and `get()` resolve to rich handles — data records you can also act on:

```ts
const server = await client.servers.get("srv_abc");
await server.tasks.create("...");        // sub-resources are scoped to the server
await server.files.write("app.py", "...");
await server.deploy();
await server.refresh();                  // re-fetch in place

const project = await client.projects.get("prj_xyz");
await project.update({ visibility: "public" });
```

`task.wait()` / `build.wait()` poll until a terminal state; both accept
`{ pollIntervalMs, timeoutMs }`.

## Errors

Every failure is an instance of `Server4AgentError`, so you can catch broadly or
narrowly:

```ts
import { NotFoundError, RateLimitError, APIStatusError } from "@server4agent/sdk";

try {
  await client.servers.get("srv_missing");
} catch (err) {
  if (err instanceof NotFoundError) {
    // 404
  } else if (err instanceof RateLimitError) {
    // 429 (already retried; quote err.requestId to support)
  } else if (err instanceof APIStatusError) {
    console.log(err.status, err.code, err.message, err.requestId);
  }
}
```

Retryable failures (429, 5xx, network blips) are retried automatically with
exponential backoff. Tune it per client:

```ts
new Server4Agent({ timeoutMs: 30_000, maxRetries: 4 });
```

## Verifying webhooks

```ts
import { verifyWebhookSignature } from "@server4agent/sdk";

// req.text() must be the raw body — parse it as JSON only after verifying.
const raw = await req.text();
const ok = await verifyWebhookSignature(
  process.env.SERVER4AGENT_WEBHOOK_SECRET!,
  raw,
  req.headers.get("server4agent-signature"),
);
if (!ok) return new Response("invalid signature", { status: 401 });
```

## API surface

`servers`, `projects`, `templates`, `tasks`, `builds`, `files`, `keys`,
`webhooks` — see the [REST API docs](https://www.server4agent.com/docs/api) for
the endpoints each method wraps.

Server-side only: this SDK holds your `sk_live_` key. Never ship it in a
browser bundle.
