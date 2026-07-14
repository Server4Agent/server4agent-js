# Security policy

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue or PR.

- Use GitHub's private vulnerability reporting on this repo (**Security → Report a
  vulnerability**), or
- email **security@server4agent.com**.

We aim to acknowledge reports within 3 business days.

## Handling your API key

This SDK holds an `sk_live_` key and is meant for **server-side** use only.

- Never ship it in a browser bundle or commit it to source control.
- The client keeps the key in a private field, so `console.log(client)` and
  `JSON.stringify(client)` will not print it — but your own logging of the raw
  key still can. Scrub it from logs.
- Rotate a key immediately if it may have been exposed (`client.keys.revoke(id)`).

## Supported versions

Only the latest published `0.x` release receives security fixes while the SDK
is pre-1.0.
