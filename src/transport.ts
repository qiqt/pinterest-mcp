import { setTimeout } from 'node:timers/promises';
import { PinterestError, type Raw, type RequestOptions, type PageOptions, type Page } from './types.ts';

export const WEB = 'https://www.pinterest.com';
export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': USER_AGENT,
  Accept: 'application/json, text/javascript, */*; q=0.01',
  'Accept-Language': 'en-US,en;q=0.9',
  'X-Requested-With': 'XMLHttpRequest',
  'X-Pinterest-PWS-Handler': 'www/index.js',
};

export const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));
export const checkCancelled = (options: RequestOptions = {}): void => options.signal?.throwIfAborted();
export const requestSignal = (options: RequestOptions = {}, timeout = 20_000): AbortSignal =>
  options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
const sleep = (ms: number, options: RequestOptions) => setTimeout(ms, undefined, { signal: options.signal });

export function record(value: unknown, label: string): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new PinterestError(502, `Invalid ${label} response.`);
  return value as Raw;
}

export async function fetchJson(
  url: string,
  headers: Record<string, string>,
  options: RequestOptions = {},
): Promise<{ status: number; body: Raw }> {
  let failure: PinterestError | undefined;
  let delay = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    checkCancelled(options);
    if (delay) await sleep(delay, options);
    let response: Response;
    let bodyText: string;
    try {
      response = await fetch(url, { headers, signal: requestSignal(options) });
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        bodyText = '';
      } else {
        bodyText = await response.text();
      }
    } catch (error) {
      checkCancelled(options);
      failure = new PinterestError(0, `Could not reach Pinterest: ${errorMessage(error)}`);
      delay = 600 * 2 ** attempt;
      continue;
    }
    const status = response.status;
    if (status === 429 || status >= 500) {
      failure = new PinterestError(status, `Pinterest returned HTTP ${status}.`);
      const retryAfter = response.headers.get('retry-after')?.trim();
      const requestedDelay = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter) * 1000
          : Date.parse(retryAfter) - Date.now()
        : 0;
      // Do not retry earlier than requested or hold a tool open for a long cooldown.
      if (requestedDelay > 30_000) throw failure;
      delay = Math.max(600 * 2 ** attempt, Number.isFinite(requestedDelay) ? requestedDelay : 0);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw new PinterestError(status, `Pinterest returned a non-JSON response (HTTP ${status}).`);
    }
    checkCancelled(options);
    return { status, body: record(parsed, 'Pinterest JSON') };
  }
  throw failure!;
}

export async function resource(
  name: string,
  data: Raw,
  sourceUrl: string,
  options: RequestOptions = {},
): Promise<{ data: any; bookmark?: string }> {
  const query = new URLSearchParams({ source_url: sourceUrl, data: JSON.stringify({ options: data, context: {} }) });
  const url = `${WEB}/resource/${name}/get/?${query}`;
  let result = await fetchJson(url, HEADERS, options);
  for (let retry = 0; retry < 2 && result.status === 403 && result.body.resource_response?.error; retry++) {
    await sleep(400 * (retry + 1), options);
    result = await fetchJson(url, HEADERS, options);
  }
  if (result.status >= 400 && !result.body.resource_response) {
    throw new PinterestError(result.status, `Pinterest request failed (HTTP ${result.status}).`);
  }
  const response = record(result.body.resource_response, name);
  if (result.status >= 400 || response.error) {
    throw new PinterestError(
      response.error?.http_status ?? result.status,
      response.error?.message ?? `Pinterest request failed (HTTP ${result.status}).`,
    );
  }
  const bookmark =
    typeof response.bookmark === 'string' && response.bookmark !== '-end-' ? response.bookmark : undefined;
  return { data: response.data, bookmark };
}

export const api = (path: string, data: Raw = {}, options: RequestOptions = {}) =>
  resource('ApiResource', { url: path, data }, '/', options);

export function validateLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new PinterestError(400, 'Limit must be an integer from 1 to 100.');
}

export async function paginate<T>(
  fetchPage: (pageSize: number, bookmark?: string) => Promise<{ items: T[]; bookmark?: string }>,
  options: PageOptions<T>,
): Promise<Page<T>> {
  const { limit = 25, cursor } = options;
  validateLimit(limit);
  checkCancelled(options);
  const items = cursor ? [...cursor.buffer] : [];
  let bookmark = cursor?.bookmark;
  let exhausted = cursor !== undefined && !bookmark;
  const visited = new Set<string>();
  for (let page = 0; items.length < limit && !exhausted && page < 8; page++) {
    checkCancelled(options);
    if (bookmark) visited.add(bookmark);
    const result = await fetchPage(Math.min(50, Math.max(limit - items.length, 10)), bookmark);
    items.push(...result.items);
    exhausted = !result.bookmark || visited.has(result.bookmark);
    bookmark = exhausted ? undefined : result.bookmark;
    await options.onProgress?.(page + 1, 'Loading results');
  }
  checkCancelled(options);
  const buffer = items.splice(limit);
  return { items, next: buffer.length || bookmark ? { bookmark, buffer } : undefined };
}
