import createClient, { type Client } from "openapi-fetch";
import type { components, paths, operations } from "./schema.js";
import { ProtocolError } from "./errors.js";
import { createTransport } from "./transport.js";

export { APIError, ProtocolError, RateLimitError } from "./errors.js";
export type { components, paths, operations } from "./schema.js";
export type Zone = components["schemas"]["Zone"];
export type Record = components["schemas"]["Record"];
export type RecordType = components["schemas"]["RecordType"];
export type CreateZone = components["schemas"]["CreateZoneRequest"];
export type UpdateZone = components["schemas"]["UpdateZoneRequest"];
export type CreateRecord = components["schemas"]["CreateRecordRequest"];
export type UpdateRecordByName = components["schemas"]["UpdateRecordByNameRequest"];
type Pagination = components["schemas"]["Pagination"];
type ZonesData = components["schemas"]["ZonesData"];
type RecordsData = components["schemas"]["RecordsData"];

export const DEFAULT_BASE_URL = "https://api.dnscale.eu/v1";
export interface RequestOptions { signal?: AbortSignal }
export interface PageOptions extends RequestOptions { offset?: number; limit?: number }
export interface IteratorOptions extends RequestOptions { pageSize?: number }
export interface ClientOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBackoffMs?: number;
  fetch?: typeof globalThis.fetch;
}

function envelope<T>(result: { data?: { status: "success"; data: T } }): T {
  if (!result.data || result.data.status !== "success" || result.data.data == null) {
    throw new ProtocolError("DNScale returned an invalid success envelope");
  }
  return result.data.data;
}

function resource<T extends { id: string }>(value: T | undefined): T {
  if (!value || typeof value.id !== "string" || !value.id) {
    throw new ProtocolError("DNScale returned a resource without an ID");
  }
  return value;
}

function deleted(result: { response: Response }): void {
  if (result.response.status !== 204) throw new ProtocolError("Expected HTTP 204 after deletion");
}

function nextOffset(page: Pagination, offset: number, count: number): number | undefined {
  if (!page || page.offset !== offset || page.count !== count || typeof page.has_more !== "boolean") {
    throw new ProtocolError("DNScale returned inconsistent pagination metadata");
  }
  if (!page.has_more) return;
  if (count === 0) throw new ProtocolError("DNScale returned an empty page with has_more=true");
  return offset + count;
}

function pageSize(options: IteratorOptions): number {
  const size = options.pageSize ?? 100;
  if (!Number.isInteger(size) || size < 1 || size > 100) {
    throw new RangeError("pageSize must be an integer between 1 and 100");
  }
  return size;
}

export class Zones {
  constructor(private readonly api: Client<paths>) {}

  async list(options: PageOptions = {}): Promise<ZonesData> {
    return envelope(await this.api.GET("/zones", {
      params: { query: { offset: options.offset ?? 0, limit: options.limit ?? 10 } },
      ...(options.signal ? { signal: options.signal } : {}),
    }));
  }
  async *iter(options: IteratorOptions = {}): AsyncGenerator<Zone> {
    const limit = pageSize(options);
    let offset = 0;
    while (true) {
      const page = await this.list({ ...options, limit, offset });
      if (!Array.isArray(page.zones)) throw new ProtocolError("Missing zones array");
      const next = nextOffset(page.pagination, offset, page.zones.length);
      yield* page.zones;
      if (next === undefined) return;
      offset = next;
    }
  }
  async get(zoneId: string, options: RequestOptions = {}): Promise<Zone> {
    return resource(envelope(await this.api.GET("/zones/{zone_id}", {
      params: { path: { zone_id: zoneId } }, ...options,
    })).zone);
  }
  async create(body: CreateZone, options: RequestOptions = {}): Promise<Zone> {
    return resource(envelope(await this.api.POST("/zones", { body, ...options })).zone);
  }
  async update(zoneId: string, body: UpdateZone, options: RequestOptions = {}): Promise<Zone> {
    return resource(envelope(await this.api.PUT("/zones/{zone_id}", {
      params: { path: { zone_id: zoneId } }, body, ...options,
    })).zone);
  }
  async delete(zoneId: string, options: RequestOptions = {}): Promise<void> {
    deleted(await this.api.DELETE("/zones/{zone_id}", { params: { path: { zone_id: zoneId } }, ...options }));
  }
}

export class Records {
  constructor(private readonly api: Client<paths>) {}

  async list(zoneId: string, options: PageOptions = {}): Promise<RecordsData> {
    return envelope(await this.api.GET("/zones/{zone_id}/records", {
      params: { path: { zone_id: zoneId }, query: { offset: options.offset ?? 0, limit: options.limit ?? 50 } },
      ...(options.signal ? { signal: options.signal } : {}),
    }));
  }
  async *iter(zoneId: string, options: IteratorOptions = {}): AsyncGenerator<Record> {
    const limit = pageSize(options);
    let offset = 0;
    while (true) {
      const page = await this.list(zoneId, { ...options, limit, offset });
      if (!Array.isArray(page.records)) throw new ProtocolError("Missing records array");
      const next = nextOffset(page.pagination, offset, page.records.length);
      yield* page.records;
      if (next === undefined) return;
      offset = next;
    }
  }
  async get(zoneId: string, recordId: string, options: RequestOptions = {}): Promise<Record> {
    return resource(envelope(await this.api.GET("/zones/{zone_id}/records/{record_id}", {
      params: { path: { zone_id: zoneId, record_id: recordId } }, ...options,
    })).record);
  }
  async create(zoneId: string, body: CreateRecord, options: RequestOptions = {}): Promise<Record> {
    return resource(envelope(await this.api.POST("/zones/{zone_id}/records", {
      params: { path: { zone_id: zoneId } }, body, ...options,
    })).record);
  }
  async update(zoneId: string, recordId: string, body: CreateRecord, options: RequestOptions = {}): Promise<Record> {
    return resource(envelope(await this.api.PUT("/zones/{zone_id}/records/{record_id}", {
      params: { path: { zone_id: zoneId, record_id: recordId } }, body, ...options,
    })).record);
  }
  async delete(zoneId: string, recordId: string, options: RequestOptions = {}): Promise<void> {
    deleted(await this.api.DELETE("/zones/{zone_id}/records/{record_id}", {
      params: { path: { zone_id: zoneId, record_id: recordId } }, ...options,
    }));
  }
  async updateByName(zoneId: string, name: string, type: RecordType, body: UpdateRecordByName,
    options: RequestOptions & { content?: string } = {}): Promise<Record> {
    return resource(envelope(await this.api.PUT("/zones/{zone_id}/records/by-name/{record_name}/{record_type}", {
      params: { path: { zone_id: zoneId, record_name: name, record_type: type },
        query: options.content === undefined ? {} : { content: options.content } },
      body, ...(options.signal ? { signal: options.signal } : {}),
    })).record);
  }
  async deleteByName(zoneId: string, name: string, type: RecordType,
    options: RequestOptions & { content?: string } = {}): Promise<void> {
    if (options.content === "") throw new TypeError("content must be non-empty; omit it to delete the whole RRset");
    deleted(await this.api.DELETE("/zones/{zone_id}/records/by-name/{record_name}/{record_type}", {
      params: { path: { zone_id: zoneId, record_name: name, record_type: type },
        query: options.content === undefined ? {} : { content: options.content } },
      ...(options.signal ? { signal: options.signal } : {}),
    }));
  }
}

export class DNScale {
  /** Typed access to every operation in the published OpenAPI contract. */
  readonly api: Client<paths>;
  readonly zones: Zones;
  readonly records: Records;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? process.env.DNSCALE_API_KEY;
    if (!apiKey?.trim()) throw new TypeError("A DNScale API key is required");
    const timeoutMs = options.timeoutMs ?? 10_000;
    const maxRetries = options.maxRetries ?? 2;
    const retryBackoffMs = options.retryBackoffMs ?? 250;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      throw new RangeError("timeoutMs must be a positive integer up to 2147483647");
    }
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 100) {
      throw new RangeError("maxRetries must be an integer between 0 and 100");
    }
    if (!Number.isFinite(retryBackoffMs) || retryBackoffMs < 0) throw new RangeError("Invalid retryBackoffMs");
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    const url = new URL(baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError("baseUrl must be an HTTP(S) URL without credentials, query, or fragment");
    }
    this.api = createClient<paths>({ baseUrl, fetch: createTransport({
      apiKey, timeoutMs, maxRetries, retryBackoffMs, fetch: options.fetch ?? globalThis.fetch,
    }) });
    this.zones = new Zones(this.api);
    this.records = new Records(this.api);
  }
}
