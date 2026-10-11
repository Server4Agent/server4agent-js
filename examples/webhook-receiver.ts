/**
 * Minimal Express receiver that verifies webhook signatures before acting.
 * Always verify against the RAW body, before JSON.parse.
 *
 *   npm install express
 *   SERVER4AGENT_WEBHOOK_SECRET=whsec_... npx tsx webhook-receiver.ts
 */
import express from "express";
import { verifyWebhookSignature } from "@server4agent/sdk";

const app = express();

app.post(
  "/hooks/server4agent",
  express.text({ type: "*/*" }),
  async (req, res) => {
    const ok = await verifyWebhookSignature(
      process.env.SERVER4AGENT_WEBHOOK_SECRET!,
      req.body, // raw string
      req.header("Server4Agent-Signature"),
    );
    if (!ok) return res.status(401).end();

    const event = JSON.parse(req.body);
    switch (event.event) {
      case "deployment.live":
        console.log("live at", event.url);
        break;
      case "task.failed":
        console.log("task failed:", event.task_id);
        break;
      default:
        console.log("event:", event.event);
    }
    res.status(200).end();
  },
);

app.listen(3000, () => console.log("listening on :3000"));
