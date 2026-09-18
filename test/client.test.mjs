import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { DNScale, APIError, RateLimitError, ProtocolError } from "../dist/index.js";
import { retryDelay } from "../dist/transport.js";

const zoneId = "00000000-0000-4000-8000-000000000001";
const zone = { id: zoneId, customer_id: zoneId, name: "example.com", type: "master",
  region: "EU", status: "active", created_at: "2026-09-18T00:00:00Z", updated_at: "2026-09-18T00:00:00Z" };
const record = { id: "opaque/+id=", name: "www.example.com.", type: "TXT", content: "value", ttl: 300, disabled: false };
const response = (data, status = 200) => Response.json({ status: "success", data }, { status });
const failure = (status, headers = {}) => Response.json({ status: "error", error: { code: "TEST_ERROR", message: "failure" } }, { status, headers });

test("zone CRUD uses versioned routes, bearer authentication, and envelopes", async () => {
  const seen = [];
  const dns = new DNScale({ apiKey: "test", fetch: async (request) => {
    assert.equal(request.headers.get("Authorization"), "Bearer test");
    assert.equal(request.headers.get("User-Agent"), "dnscale-typescript/0.1.0");
    assert.equal(request.redirect, "error");
    assert.match(request.url, /^https:\/\/api.dnscale.eu\/v1\/zones/);
    seen.push(request.method);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (["POST", "PUT"].includes(request.method)) assert.equal((await request.json()).name, "example.com");
    return response({ zone }, request.method === "POST" ? 201 : 200);
  }});
  assert.equal((await dns.zones.create({ name: zone.name })).id, zoneId);
  assert.equal((await dns.zones.get(zoneId)).name, zone.name);
  await dns.zones.update(zoneId, { name: zone.name });
  await dns.zones.delete(zoneId);
  assert.deepEqual(seen, ["POST", "GET", "PUT", "DELETE"]);
});

test("record CRUD preserves content and escapes opaque IDs", async () => {
  const dns = new DNScale({ apiKey: "test", fetch: async (request) => {
    if (["GET", "PUT", "DELETE"].includes(request.method)) assert.match(request.url, /opaque%2F%2Bid%3D$/);
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    if (request.method !== "GET") {
      const body = await request.json();
      assert.equal(body.content, "value");
      assert.equal(body.comment, null);
    }
    return response({ record }, request.method === "POST" ? 201 : 200);
  }});
  await dns.records.create(zoneId, { ...record, comment: null });
  await dns.records.get(zoneId, record.id);
  await dns.records.update(zoneId, record.id, { ...record, comment: null });
  await dns.records.delete(zoneId, record.id);
});

test("by-name operations preserve the selected TXT value", async () => {
  const seen = [];
  const dns = new DNScale({ apiKey: "test", fetch: async (request) => {
    const url = new URL(request.url);
    assert.equal(url.searchParams.get("content"), "old + / & value");
    seen.push(request.method);
    return request.method === "DELETE" ? new Response(null, { status: 204 }) : response({ record });
  }});
  await dns.records.updateByName(zoneId, record.name, "TXT", { content: "new" }, { content: "old + / & value" });
  await dns.records.deleteByName(zoneId, record.name, "TXT", { content: "old + / & value" });
  await assert.rejects(dns.records.deleteByName(zoneId, record.name, "TXT", { content: "" }), TypeError);
  assert.deepEqual(seen, ["PUT", "DELETE"]);
});

for (const resource of ["zones", "records"]) {
  test(`${resource} iteration follows server-limited pages`, async () => {
    const offsets = [];
    const dns = new DNScale({ apiKey: "test", fetch: async (request) => {
      const offset = Number(new URL(request.url).searchParams.get("offset"));
      offsets.push(offset);
      return response({ [resource]: [resource === "zones" ? zone : record], pagination: {
        offset, count: 1, limit: 1, total: 2, has_more: offset === 0,
      }});
    }});
    const items = [];
    for await (const item of resource === "zones" ? dns.zones.iter() : dns.records.iter(zoneId)) items.push(item);
    assert.equal(items.length, 2);
    assert.deepEqual(offsets, [0, 1]);
  });
}

test("iterator rejects non-progressing pagination", async () => {
  const dns = new DNScale({ apiKey: "test", fetch: async () => response({ zones: [], pagination: {
    offset: 0, count: 0, limit: 100, total: 2, has_more: true,
  }}) });
  await assert.rejects(async () => { for await (const _ of dns.zones.iter()) {} }, ProtocolError);
});

test("safe requests retry transient failures", async () => {
  let attempts = 0;
  const dns = new DNScale({ apiKey: "test", retryBackoffMs: 0, fetch: async () => {
    if (++attempts === 1) throw new TypeError("network disconnected");
    return attempts === 2 ? failure(503) : response({ zone });
  }});
  await dns.zones.get(zoneId);
  assert.equal(attempts, 3);
});

test("long Retry-After surfaces metadata without retrying early", async () => {
  let attempts = 0;
  const dns = new DNScale({ apiKey: "test", fetch: async () => {
    attempts++;
    return failure(429, { "Retry-After": "120", "X-Request-ID": "req-1" });
  }});
  await assert.rejects(dns.zones.list(), error => error instanceof RateLimitError
    && error.retryAfter === "120" && error.requestId === "req-1" && error.code === "TEST_ERROR");
  assert.equal(attempts, 1);
  const dateDelay = retryDelay(new Response(null, { headers: { "Retry-After": new Date(Date.now() + 120_000).toUTCString() } }), 0, 250);
  assert.ok(dateDelay > 118_000);
});

for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} is never retried`, async () => {
    let attempts = 0;
    const dns = new DNScale({ apiKey: "test", retryBackoffMs: 0, fetch: async () => { attempts++; return failure(503); } });
    await assert.rejects(dns.api[method]("/zones", { body: { name: "example.com" } }), APIError);
    assert.equal(attempts, 1);
  });
}

test("non-JSON gateway errors keep status and request ID", async () => {
  const dns = new DNScale({ apiKey: "test", maxRetries: 0, fetch: async () =>
    new Response("<html>unavailable</html>", { status: 502, headers: { "X-Request-ID": "proxy" } }) });
  await assert.rejects(dns.zones.list(), error => error instanceof APIError && error.statusCode === 502 && error.requestId === "proxy");
});

test("cancellation interrupts retry waits", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const dns = new DNScale({ apiKey: "test", fetch: async () => { attempts++; setTimeout(() => controller.abort(), 5); return failure(503, { "Retry-After": "20" }); } });
  await assert.rejects(dns.zones.list({ signal: controller.signal }), { name: "AbortError" });
  assert.equal(attempts, 1);
});

test("timeout applies to an actual HTTP connection", async () => {
  const server = createServer(() => {});
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const dns = new DNScale({ apiKey: "test", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 20 });
    await assert.rejects(dns.zones.list(), { name: "TimeoutError" });
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("typed low-level API reaches endpoints beyond zone and record helpers", async () => {
  const dns = new DNScale({ apiKey: "test", fetch: async (request) => {
    assert.equal(new URL(request.url).pathname, "/v1/usage/current");
    return response({ marker: "usage" });
  }});
  assert.equal((await dns.api.GET("/usage/current")).data.data.marker, "usage");
});
