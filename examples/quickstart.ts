/**
 * Provision a server, have the agent build an app, and print the live URL.
 *
 *   SERVER4AGENT_API_KEY=sk_live_... npx tsx quickstart.ts
 */
import { Server4Agent } from "@server4agent/sdk";

const client = new Server4Agent();

const server = await client.servers.create({ tier: "small" });
console.log(`server ${server.id} (${server.status})`);

const build = await server.builds.start("a FastAPI todo API with a small web UI");
await build.wait({ onProgress: (b) => console.log(`  build: ${b.status}`) });
console.log("live at", build.url);
