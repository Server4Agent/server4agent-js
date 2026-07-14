import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyWebhookSignature } from "../src/webhooks.js";

// Server4Agent signs webhook deliveries as HMAC-SHA256("{unixTs}.{rawBody}")
// with the webhook's secret, header = `t=<ts>,v1=<hex>` (see
// lib/server/webhooks.ts). These vectors are computed independently with
// Node's crypto module, not by calling back into the SDK's own signer, so a
// bug in verifyWebhookSignature can't cancel out against a matching bug in
// how the vector was produced.
function independentHeader(secret: string, body: string, ts: number): string {
  const hex = createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${hex}`;
}

describe("verifyWebhookSignature", () => {
  it("accepts a validly signed payload", async () => {
    const body = JSON.stringify({ event: "deployment.live", server_id: "srv_1" });
    const ts = Math.floor(Date.now() / 1000);
    const header = independentHeader("whsec_test", body, ts);
    expect(await verifyWebhookSignature("whsec_test", body, header)).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const body = '{"event":"test"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = independentHeader("whsec_real", body, ts);
    expect(await verifyWebhookSignature("whsec_wrong", body, header)).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const body = '{"event":"test"}';
    const ts = Math.floor(Date.now() / 1000);
    const header = independentHeader("whsec_test", body, ts);
    expect(await verifyWebhookSignature("whsec_test", '{"event":"tampered"}', header)).toBe(false);
  });

  it("rejects an expired timestamp", async () => {
    const body = '{"event":"test"}';
    const ts = Math.floor(Date.now() / 1000) - 600;
    const header = independentHeader("whsec_test", body, ts);
    expect(await verifyWebhookSignature("whsec_test", body, header, 300)).toBe(false);
  });

  it("respects a custom tolerance", async () => {
    const body = '{"event":"test"}';
    const ts = Math.floor(Date.now() / 1000) - 600;
    const header = independentHeader("whsec_test", body, ts);
    expect(await verifyWebhookSignature("whsec_test", body, header, 3600)).toBe(true);
  });

  it("rejects a malformed header", async () => {
    expect(await verifyWebhookSignature("whsec_test", "{}", "not-a-real-header")).toBe(false);
  });

  it("rejects a missing header", async () => {
    expect(await verifyWebhookSignature("whsec_test", "{}", null)).toBe(false);
  });
});
