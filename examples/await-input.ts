/**
 * Start a task and handle the case where the on-server agent stops to ask
 * a question. wait() returns as soon as the task reaches a terminal state,
 * and "awaiting_input" is one of them.
 *
 *   SERVER4AGENT_API_KEY=sk_live_... npx tsx await-input.ts
 */
import { Server4Agent } from "@server4agent/sdk";

const client = new Server4Agent();

const server = await client.servers.create({ tier: "small" });
const task = await server.tasks.create(
  "Refactor the auth module. Ask me before changing any public API.",
);

await task.wait({ onProgress: (t) => console.log("task:", t.status) });

switch (task.status) {
  case "completed":
    console.log("done:", task.result);
    break;
  case "awaiting_input":
    console.log("agent asks:", task.question);
    // Answer with a follow-up, so the agent picks up the same conversation:
    // await server.tasks.create("Yes, go ahead. Keep the response shape.", { followUpOf: task.id });
    break;
  default:
    console.log("ended as:", task.status);
}
