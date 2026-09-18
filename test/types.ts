import { DNScale, type Zone, type Record } from "../dist/index.js";

const dns = new DNScale({ apiKey: "compile-only" });
const zone: Promise<Zone> = dns.zones.create({ name: "example.com", region: "EU", type: "master" });
const record: Promise<Record> = dns.records.create("zone-id", { name: "www", type: "A", content: "192.0.2.1" });
void zone; void record;
void dns.api.GET("/billing/summary");
// @ts-expect-error unsupported record types must fail at compile time
void dns.records.create("zone-id", { name: "www", type: "INVALID", content: "value" });
// @ts-expect-error unknown routes must fail at compile time
void dns.api.GET("/not-an-endpoint");
// @ts-expect-error creating a record requires content
void dns.records.create("zone-id", { name: "www", type: "A" });
