/**
 * Write a file, install a dependency, and run it, all on the server.
 * The workspace is durable, so the file and the installed package persist.
 *
 *   SERVER4AGENT_API_KEY=sk_live_... npx tsx exec-and-files.ts
 */
import { Server4Agent } from "@server4agent/sdk";

const client = new Server4Agent();

const server = await client.servers.create({ tier: "small" });
console.log(`server ${server.id} (${server.status})`);

await server.files.write(
  "hello.py",
  "import httpx\nprint('httpx', httpx.__version__)\n",
);

await server.exec("pip install httpx");
console.log(await server.exec("python hello.py"));

console.log("files:", await server.files.list());
