import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DNScale } from "../dist/index.js";

test("live disposable zone and record lifecycle", { skip: process.env.DNSCALE_LIVE_TEST !== "1" }, async () => {
  assert.ok(process.env.DNSCALE_TEST_API_KEY);
  assert.ok(process.env.DNSCALE_TEST_BASE_URL);
  const dns = new DNScale({ apiKey: process.env.DNSCALE_TEST_API_KEY, baseUrl: process.env.DNSCALE_TEST_BASE_URL, maxRetries: 0 });
  const zone = await dns.zones.create({ name: `sdk-${randomUUID()}.example.com`, region: "EU", type: "master" });
  try {
    assert.equal((await dns.zones.get(zone.id)).id, zone.id);
    const record = await dns.records.create(zone.id, { name: "sdk", type: "TXT", content: "first", ttl: 300 });
    const records = [];
    for await (const item of dns.records.iter(zone.id, { pageSize: 1 })) records.push(item);
    assert.ok(records.some(item => item.id === record.id));
    const updated = await dns.records.update(zone.id, record.id, { name: record.name, type: "TXT", content: "second", ttl: 300 });
    assert.equal((await dns.records.get(zone.id, updated.id)).content, "second");
    await dns.records.delete(zone.id, updated.id);
    for await (const item of dns.records.iter(zone.id)) assert.notEqual(item.id, updated.id);
  } finally { await dns.zones.delete(zone.id); }
});
