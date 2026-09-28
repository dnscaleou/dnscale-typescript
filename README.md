# DNScale TypeScript SDK

Typed Node.js client for the DNScale API, with types generated from the public
OpenAPI contract bundled as [openapi.yaml](openapi.yaml). Requires Node.js 20.19+
and uses ESM.

## Installation

```bash
npm install @dnscale/dnscale
```

## Quick start

Create an API key in the DNScale dashboard and supply it through `DNSCALE_API_KEY`
or the client's `apiKey` option.

```ts
import { DNScale } from "@dnscale/dnscale";

const dns = new DNScale(); // reads DNSCALE_API_KEY
for await (const zone of dns.zones.iter()) {
  for await (const record of dns.records.iter(zone.id)) {
    console.log(zone.name, record.name, record.content);
  }
}

const zone = await dns.zones.create({ name: "example.com", region: "EU", type: "master" });
const record = await dns.records.create(zone.id, {
  name: "www", type: "A", content: "192.0.2.10", ttl: 300,
});
const updated = await dns.records.update(zone.id, record.id, {
  name: record.name, type: "A", content: "192.0.2.11", ttl: 300,
});
await dns.records.delete(zone.id, updated.id);
```

Keep API keys on the server. This SDK does not use dashboard session cookies or
UI state. `new DNScale({ apiKey, baseUrl, timeoutMs, maxRetries, retryBackoffMs,
fetch })` supports dependency injection and sandbox endpoints. `baseUrl` includes
`/v1` (default `https://api.dnscale.eu/v1`). Redirects are rejected.

## Behaviour

- `zones` and `records` expose `list`, `get`, `create`, `update`, `delete`, and
  lazy async `iter`. `list` returns one page; `iter` follows `has_more` using the
  actual returned count and rejects inconsistent or non-progressing pages.
- `iter({ pageSize })` and `records.iter(zoneId, { pageSize })` accept 1–100.
  Offset pagination is not an atomic snapshot under concurrent changes.
- Record IDs are opaque and content-derived. Retain the returned ID after an
  update. `records.updateByName(zoneId, name, type, body, { content: oldValue })`
  selects one old value in a multi-value RRset.
- `records.deleteByName(zoneId, name, type, { content })` deletes a selected
  value. Omitting `content` deletes the **entire RRset**; empty content is rejected.
- GET/HEAD/OPTIONS retry network errors and 408/429/500/502/503/504, up to twice.
  POST/PUT/PATCH/DELETE are never automatically retried. `maxRetries: 0` disables
  retries. A `Retry-After` exceeding 30 seconds is surfaced instead of shortened.
- The default 10-second deadline includes retries and waiting. Every helper
  accepts `{ signal }` for cancellation. The native fetch implementation handles
  connection pooling; there is no SDK close method.
- Failed HTTP responses throw `APIError` with `statusCode`, `code`, `requestId`,
  and `details`. `RateLimitError` also exposes `retryAfter`. Non-JSON gateway
  errors preserve HTTP metadata. Transport and cancellation errors remain native
  fetch errors. TypeScript types do not perform runtime schema validation.

## Complete generated API

Every public operation has generated types through `dns.api`:

```ts
const { data } = await dns.api.GET("/usage/current");
console.log(data?.data);
```

The underlying client returns success envelopes; the convenience helpers unwrap
them. Both use the same authentication, timeout, retry and throwing error policy.
Schemas and operation types are exported as `components`, `paths`, `operations`.

## Development

`npm ci && npm test` builds, checks public consumer types, and runs transport and
resource tests. `npm run generate` regenerates `src/schema.ts` from the bundled
`openapi.yaml` using a pinned generator. Commit the contract and generated types together.

Live verification creates and deletes a uniquely named disposable test zone:

```bash
export DNSCALE_TEST_BASE_URL=https://api-sandbox.dnscale.eu/v1
export DNSCALE_TEST_API_KEY=your-disposable-account-key
DNSCALE_LIVE_TEST=1 npm test
```

Supply zone/record read/write scopes on a disposable account. Normal tests skip
live requests.
