/**
 * Ephemeral preview environment for CI: one disposable public URL per PR.
 * Run it on PR open; call project.cleanup() on PR close.
 *
 *   PR_NUMBER=42 PR_BRANCH=feature/login REPO_URL=https://github.com/you/app \
 *   SERVER4AGENT_API_KEY=sk_live_... npx tsx preview-env.ts
 *
 * START_COMMAND overrides how the app starts (default "npm start"). It must
 * stay in the foreground and listen on $PORT.
 */
import { ConflictError, Server4Agent } from "@server4agent/sdk";

const client = new Server4Agent();
const pr = process.env.PR_NUMBER ?? "0";
const branch = process.env.PR_BRANCH ?? "main";
const repo = process.env.REPO_URL ?? "https://github.com/you/app";

const server = await client.servers.create({ task: `pr-${pr}` });
const project = await server.projects.create({ name: `pr-${pr}`, lifecycle: "ephemeral" });

// A project's URL serves whatever listens on its port, so the code has to
// live and run in the project's folder, not at the server root. A task given
// the project works in that folder.
const task = await server.tasks.create(
  `Clone ${repo} at branch ${branch} into this folder, install its dependencies and build it. Do not start it.`,
  { projectId: project.id },
);
await task.wait({ timeoutMs: 900_000, onProgress: (t) => console.log("task:", t.status) });
if (task.status !== "completed") {
  throw new Error(`Preview build ${task.status}: ${task.question ?? task.result ?? ""}`);
}

// Run the app on the project's port; it keeps running across restarts.
try {
  await project.start(process.env.START_COMMAND ?? "npm start");
} catch (err) {
  if (err instanceof ConflictError) console.error(err.body?.log_tail); // why it exited
  throw err;
}

// deploy() builds and starts nothing: it checks the app is listening, makes
// the project public, and waits for the URL to answer.
const { url, status } = await project.deploy();

console.log(`Preview (${status}): ${url}`);
// On PR close, tear it down:
// await project.cleanup();
