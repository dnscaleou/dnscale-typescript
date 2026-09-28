import { responseError } from "./errors.js";

export interface TransportOptions {
  apiKey: string;
  timeoutMs: number;
  maxRetries: number;
  retryBackoffMs: number;
  fetch: typeof globalThis.fetch;
}

const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504]);
const maxRetryDelayMs = 30_000;

export function retryDelay(response: Response | undefined, attempt: number, backoff: number): number {
  const value = response?.headers.get("Retry-After");
  if (value?.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return Math.max(0, numeric * 1000);
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  }
  return Math.min(backoff * 2 ** attempt, maxRetryDelayMs);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createTransport(options: TransportOptions): (request: Request) => Promise<Response> {
  return async (input) => {
    const headers = new Headers(input.headers);
    headers.set("Authorization", `Bearer ${options.apiKey}`);
    headers.set("Accept", "application/json");
    headers.set("User-Agent", "dnscale-typescript/1.0.0");
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(options.timeoutMs)]);
    const request = new Request(input, { headers, signal, redirect: "error" });
    const safe = safeMethods.has(request.method);
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await options.fetch(request.clone());
      } catch (error) {
        if (!safe || attempt >= options.maxRetries || signal.aborted || !(error instanceof TypeError)) {
          throw error;
        }
        await sleep(retryDelay(undefined, attempt, options.retryBackoffMs), signal);
        continue;
      }
      if (safe && retryableStatuses.has(response.status) && attempt < options.maxRetries) {
        const delay = retryDelay(response, attempt, options.retryBackoffMs);
        if (delay <= maxRetryDelayMs) {
          await response.body?.cancel();
          await sleep(delay, signal);
          continue;
        }
      }
      if (!response.ok) throw await responseError(response);
      return response;
    }
  };
}
