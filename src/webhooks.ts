// Verifies the `Server4Agent-Signature` header Server4Agent sends with every
// webhook delivery. Mirrors the server's HMAC-SHA256 scheme exactly:
// header = `t=<unix seconds>,v1=<hex hmac of "${t}.${rawBody}">`.

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sign(secret: string, body: string, timestamp: number): Promise<string> {
  const data = new TextEncoder().encode(`${timestamp}.${body}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return `t=${timestamp},v1=${toHex(sig)}`;
}

/**
 * Verify a webhook delivery. `body` must be the raw request body exactly as
 * received (parsing and re-serializing JSON will change the bytes and break
 * the signature). `header` is the `Server4Agent-Signature` header value.
 * Rejects deliveries older than `toleranceSec` (default 300s) to limit
 * replay windows.
 */
export async function verifyWebhookSignature(
  secret: string,
  body: string,
  header: string | null | undefined,
  toleranceSec = 300,
): Promise<boolean> {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, v] = p.split("=");
      return [k, v ?? ""];
    }),
  );
  const timestamp = Number(parts.t);
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;
  const age = Math.abs(Date.now() / 1000 - timestamp);
  if (age > toleranceSec) return false;

  const expected = await sign(secret, body, timestamp);
  const expectedV1 = expected.split("v1=")[1];
  if (!expectedV1 || expectedV1.length !== v1.length) return false;

  let mismatch = 0;
  for (let i = 0; i < expectedV1.length; i++) {
    mismatch |= expectedV1.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return mismatch === 0;
}
