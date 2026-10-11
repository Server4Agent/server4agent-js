# @server4agent/sdk

JavaScript/TypeScript client for the [Server4Agent](https://www.server4agent.com)
REST API: fully typed, promise-based, with automatic retries.

This SDK is for the code *around* your agent: your backend, a CI job, a
webhook receiver, an admin script. If your agent itself does tool-calling,
point it at the [MCP server](https://www.server4agent.com/docs/mcp) directly;
it doesn't need this package.

## Install

```bash
npm install @server4agent/sdk
```

ESM, Node 22+ (uses the built-in `fetch`). Ships its own types.

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

`create()` and `get()` resolve to rich handles, data records you can also act on:

```ts
const server = await client.servers.get("srv_abc");
await server.tasks.create("...");        // sub-resources are scoped to the server
await server.files.write("app.py", "...");
await server.refresh();                  // re-fetch in place

const project = await client.projects.get("prj_xyz");
await project.update({ visibility: "public" });
```

Every handle method also has a flat form on the client that takes ids
(`client.tasks.create(serverId, goal)`, `client.projects.start(projectId, cmd)`).

Binary files (e.g. a generated `.xlsx`) round-trip through `write`/`readBinary`
without corruption, and `getDownloadUrl` mints a shareable, expiring link:

```ts
await server.files.write("report.xlsx", xlsxBytes);          // Uint8Array/Buffer -> base64 on the wire
const bytes = await server.files.readBinary("report.xlsx");  // decoded back to a Buffer

const { url, expiresAt } = await server.files.getDownloadUrl("report.xlsx", { ttlSeconds: 3600 });
```

`server.kind` says what sort of box you are holding: `"standard"` is headless,
`"browser"` has a screen with a browser on it, for sites an agent has to drive
rather than fetch. It is orthogonal to `tier`, and a nickname proves nothing, so
read the field rather than the name:

```ts
const server = await client.servers.create({ tier: "medium", kind: "browser" });
const withScreens = (await client.servers.list()).filter((s) => s.kind === "browser");
```

`task.wait()` / `build.wait()` poll until a terminal state; both accept
`{ pollIntervalMs, timeoutMs }`.

Not every task in a server's list is one you sent. `task.messageType` is
`"system"` for runs the platform starts for you, such as the bring-up of a
project imported from git, and `"user"` for your own. A system task's `goal` is
a summary of what the run does, not the instructions its agent was given:

```ts
const mine = (await server.tasks.list()).filter((t) => t.messageType === "user");
```

A task runs at the server's workspace root unless you give it a project, and
answering one that stopped at `awaiting_input` is a follow-up, so the agent
keeps the conversation:

```ts
const task = await server.tasks.create("Add a login form", { projectId: project.id });
await task.wait();
if (task.status === "awaiting_input") {
  await server.tasks.create("Use email and password.", { followUpOf: task.id });
}
console.log(task.change?.files, task.usage?.cost);
```

## Running and deploying a project

A project is a folder and an app inside a server, with its own URL. Start the
app, then deploy it, which checks something is listening and makes it public:

```ts
const project = await server.projects.create({ name: "api" });
await server.files.write("api/server.js", code);

const app = await project.start("node server.js");  // { status, listening, logTail, ... }
const { url, status } = await project.deploy();      // status: "live" | "publishing"

const logs = await project.logs({ lines: 50 });      // or server.logs({ projectId, lines })
```

`server.deploy({ projectId })` does the same and resolves to the URL. A deploy
with nothing listening fails with a `ConflictError`; a start whose app exits
fails with one too, and its `err.body.log_tail` says why. `logs()` resolves to
null until the server has reported any; when the server cannot be reached the
API answers with the last saved tails, so check `logs.updatedAt`.

A project can also be seeded from your own code, which brings itself up:

```ts
const fromGit = await server.projects.create({
  source: { kind: "git", gitUrl: "https://github.com/you/app", authSecret: "GIT_TOKEN" },
});
await client.tasks.get(server.id, fromGit.initRunId!);  // the bring-up run
await fromGit.init({ proceed: true });                  // resume one waiting on secrets
await fromGit.update({ runPlan: { install: "npm ci", start: "npm start", port: 3000 } });
```

## Secrets

Environment variables bound to a server (every project on it sees them) or to
one project. Values are write-only: no read ever returns one.

```ts
await server.secrets.set([{ key: "DATABASE_URL", value: process.env.DATABASE_URL! }]);
await project.secrets.set([{ key: "STRIPE_KEY", value: "rk_live_..." }]);
const seen = await project.secrets.list();           // its own plus the server's

await client.secrets.set({ key: "OPENAI_KEY", value: "...", description: "model key" });
const all = await client.secrets.list();             // keys, masked hints, bindings
await client.secrets.delete(all[0].id);              // removes it everywhere
```

## Moving a project between deployments

```ts
const bundle = await project.export({ ttlSeconds: 3600 });  // { url, filename, bytes, env }
const bytes = new Uint8Array(await (await fetch(bundle.url)).arrayBuffer());

const imported = await otherServer.projects.import(bytes, { name: "api-copy" });
console.log(imported.missingEnv);   // set these with imported.project.secrets.set()
```

A bundle carries the names of the variables a project reads, never their
values, and an import always lands private.

## Account and budget

```ts
const me = await client.me();
if (me.usage.blocked) console.log("out of budget:", me.usage.reason);
```

## Tuning runs

Fix an agent from an evaluation platform's report. Reading a run is what moves
it along, so `wait()` polls until the outcome is reported:

```ts
const { session } = await client.tuning.start({ proposalId: "prop_123", projectId: project.id });
await session.wait();                      // "reported" or "failed", or the run asks a question
console.log(session.status, session.changeSummary, session.run?.question);
await session.report({ changeSummary: "Grounded answers in the product docs" });
```
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

// req.text() must be the raw body. Parse it as JSON only after verifying.
const raw = await req.text();
const ok = await verifyWebhookSignature(
  process.env.SERVER4AGENT_WEBHOOK_SECRET!,
  raw,
  req.headers.get("server4agent-signature"),
);
if (!ok) return new Response("invalid signature", { status: 401 });
```

## Examples

Runnable scripts in [`examples/`](examples/):

| File | What it shows |
| --- | --- |
| [`quickstart.ts`](examples/quickstart.ts) | Provision a server, build an app, print the live URL. |
| [`exec-and-files.ts`](examples/exec-and-files.ts) | Write a file, install a dependency, and run it on the durable workspace. |
| [`await-input.ts`](examples/await-input.ts) | Handle a task that pauses to ask a question (`awaiting_input`). |
| [`preview-env.ts`](examples/preview-env.ts) | Ephemeral per-PR preview URL for CI. |
| [`webhook-receiver.ts`](examples/webhook-receiver.ts) | Verify webhook signatures in an Express handler. |

## API surface

`servers`, `projects`, `templates`, `tasks`, `builds`, `files`, `secrets`,
`tuning`, `keys`, `webhooks`, and `client.me()`. Every REST endpoint has a
method; see the [REST API docs](https://www.server4agent.com/docs/api) for the
endpoint each one wraps.

Server-side only: this SDK holds your `sk_live_` key. Never ship it in a
browser bundle.
