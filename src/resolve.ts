import { type Pin, type Raw, type RequestOptions, PinterestError } from './types.ts';
import { isNumericId, parsePinId, parseBoardPath, signatureOf } from './parse.ts';
import { WEB, USER_AGENT, fetchJson, resource, checkCancelled, record } from './transport.ts';
import { toPin } from './normalize.ts';
import { createSingleFlight, createKeyedQueue } from './concurrency.ts';

interface ListedPin {
  pin: Pin;
  signature?: string;
  boardPath?: string;
  username?: string;
  createdAt?: string;
  aggregatedId?: string;
}

function boardPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    return parseBoardPath(value);
  } catch {
    return undefined;
  }
}

export function cacheSet<K, V>(cache: Map<K, V>, max: number, key: K, value: V): void {
  if (!cache.has(key) && cache.size >= max) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

// Fresh metadata expires; references to previously listed pins last for the session.
const TTL = 5 * 60_000;
type Cached<T> = { value: T; expires: number };
const fresh = <T>(cache: Map<string, Cached<T>>, key: string): T | undefined => {
  const entry = cache.get(key);
  if (entry && entry.expires > Date.now()) return entry.value;
  cache.delete(key);
  return undefined;
};

export function createResolver() {
  const listedPins = new Map<string, ListedPin>();
  const resolvedIds = new Map<string, string>();
  const widgets = new Map<string, Cached<Map<string, string[]>>>();
  const details = new Map<string, Cached<Raw>>();
  const userPages = new Map<string, Cached<{ rows: Raw[]; bookmark?: string; pages: number }>>();
  const detailRequests = createSingleFlight<string, Raw>();
  const widgetRequests = createSingleFlight<string, Map<string, string[]>>();
  const userQueue = createKeyedQueue<string>();

  function rememberListed(pin: Pin, raw: Raw): void {
    const aggregated = raw.aggregated_pin_data;
    const aggregatedId =
      aggregated?.id ??
      (typeof aggregated?.node_id === 'string'
        ? Buffer.from(aggregated.node_id, 'base64').toString().split(':')[1]
        : undefined);
    cacheSet(listedPins, 5000, pin.id, {
      pin: { ...pin },
      signature: raw.image_signature ?? signatureOf(pin.image?.url ?? pin.thumbnail),
      boardPath: boardPath(raw.board?.url),
      username: raw.pinner?.username,
      createdAt: typeof raw.created_at === 'string' ? raw.created_at : undefined,
      aggregatedId: aggregatedId && isNumericId(String(aggregatedId)) ? String(aggregatedId) : undefined,
    });
  }

  async function pinDetails(id: string, options: RequestOptions = {}): Promise<Raw> {
    checkCancelled(options);
    const cached = fresh(details, id);
    if (cached) return cached;
    return detailRequests(id, options.signal, async (signal) => {
      const { data } = await resource('PinResource', { id, field_set_key: 'detailed' }, `/pin/${id}/`, { signal });
      const value = record(data, 'pin');
      if (toPin(value).id !== id) throw new PinterestError(502, 'Pinterest returned a different pin ID.');
      cacheSet(details, 500, id, { value, expires: Date.now() + TTL });
      return value;
    });
  }

  async function widgetPins(feedPath: string, options: RequestOptions = {}): Promise<Map<string, string[]>> {
    checkCancelled(options);
    const cached = fresh(widgets, feedPath);
    if (cached) return cached;
    return widgetRequests(feedPath, options.signal, async (signal) => {
      const { status, body } = await fetchJson(
        `https://widgets.pinterest.com/v3/pidgets/${feedPath}`,
        { 'User-Agent': USER_AGENT },
        { signal },
      );
      if (status >= 400 && status !== 404) throw new PinterestError(status, `Widget feed returned HTTP ${status}.`);
      const result = new Map<string, string[]>();
      for (const pin of Array.isArray(body.data?.pins) ? body.data.pins : []) {
        if (!pin || typeof pin !== 'object') continue;
        const signature = signatureOf(JSON.stringify(pin.images ?? {}));
        if (signature && isNumericId(String(pin.id)))
          result.set(signature, [...(result.get(signature) ?? []), String(pin.id)]);
      }
      cacheSet(widgets, 200, feedPath, { value: result, expires: Date.now() + TTL });
      return result;
    });
  }

  function matches(listed: ListedPin, candidate: Raw): boolean {
    const expectedTime = Date.parse(listed.createdAt ?? '');
    return (
      !!listed.signature &&
      !!listed.boardPath &&
      Number.isFinite(expectedTime) &&
      (candidate.image_signature ?? signatureOf(candidate.images?.orig?.url)) === listed.signature &&
      boardPath(candidate.board?.url) === listed.boardPath &&
      Date.parse(candidate.created_at) === expectedTime
    );
  }

  async function verify(listed: ListedPin, ids: string[], options: RequestOptions): Promise<string | undefined> {
    checkCancelled(options);
    const matchesFound: string[] = [];
    // Limit verification to five distinct candidates.
    const unique = [...new Set(ids)];
    if (unique.length > 5) return undefined;
    for (const id of unique) {
      let candidate: Raw;
      try {
        candidate = await pinDetails(id, options);
      } catch (error) {
        checkCancelled(options);
        if (error instanceof PinterestError && error.status === 404) continue;
        throw error;
      }
      if (matches(listed, candidate)) matchesFound.push(id);
    }
    checkCancelled(options);
    return matchesFound.length === 1 ? matchesFound[0] : undefined;
  }

  async function findInUserFeed(listed: ListedPin, options: RequestOptions): Promise<string | undefined> {
    checkCancelled(options);
    const targetTime = Date.parse(listed.createdAt ?? '');
    if (!listed.username || !listed.boardPath || !listed.signature || !Number.isFinite(targetTime)) return undefined;
    const username = listed.username;
    return userQueue(username, options.signal, async () => {
      const cached = fresh(userPages, username);
      let rows = [...(cached?.rows ?? [])],
        bookmark = cached?.bookmark,
        pages = cached?.pages ?? 0;
      const lastTime = () => {
        for (let i = rows.length - 1; i >= 0; i--) {
          const time = Date.parse(rows[i]?.created_at);
          if (Number.isFinite(time)) return time;
        }
        return Infinity;
      };
      // Read past the target second so candidates split across page boundaries are considered.
      while (pages < 4 && (pages === 0 || bookmark) && lastTime() >= targetTime) {
        checkCancelled(options);
        const result = await resource(
          'UserPinsResource',
          { username, page_size: 250, field_set_key: 'minimal', ...(bookmark && { bookmarks: [bookmark] }) },
          `/${encodeURIComponent(username)}/pins/`,
          options,
        );
        rows = [
          ...rows,
          ...(Array.isArray(result.data) ? result.data.filter((row) => row && typeof row === 'object') : []),
        ];
        pages++;
        const previous = bookmark;
        bookmark = result.bookmark === previous ? undefined : result.bookmark;
        cacheSet(userPages, 100, username, { value: { rows, bookmark, pages }, expires: Date.now() + TTL });
        await options.onProgress?.(pages, 'Looking for the pin page', 4);
        checkCancelled(options);
      }
      if (bookmark && pages >= 4 && lastTime() >= targetTime) return undefined;
      const ids = rows
        .filter((row) => Date.parse(row.created_at) === targetTime)
        .map((row) => /\/pin\/(?:[^/]*--)?(\d+)\/?$/.exec(row.seo_url ?? '')?.[1])
        .filter((id): id is string => !!id);
      return verify(listed, ids, options);
    });
  }

  async function resolvePinId(input: string, options: RequestOptions & { deep?: boolean } = {}): Promise<string> {
    checkCancelled(options);
    const id = parsePinId(input);
    if (isNumericId(id)) return id;
    const known = resolvedIds.get(id);
    if (known) return known;
    const listed = listedPins.get(id);
    if (!listed)
      throw new PinterestError(
        404,
        `Hidden pin ID "${id}" is unavailable in this session. Use a numeric ID or pin URL.`,
      );
    let numericId: string | undefined;
    if (listed.boardPath && listed.signature) {
      try {
        const widget = await widgetPins(`boards${listed.boardPath}pins/`, options);
        numericId = await verify(listed, widget.get(listed.signature) ?? [], options);
      } catch (error) {
        checkCancelled(options);
        if (!options.deep) throw error;
      }
    }
    if (!numericId && options.deep) numericId = await findInUserFeed(listed, options);
    checkCancelled(options);
    if (!numericId) throw new PinterestError(404, 'Could not recover the numeric ID for this pin.');
    cacheSet(resolvedIds, 5000, id, numericId);
    return numericId;
  }

  async function adoptRealId(pin: Pin, widget: Map<string, string[]>, options: RequestOptions = {}): Promise<void> {
    if (isNumericId(pin.id)) return;
    const listed = listedPins.get(pin.id);
    const signature = listed?.signature;
    if (!signature || !widget.has(signature)) return;
    try {
      const originalId = pin.id;
      const id = resolvedIds.get(originalId) ?? (await verify(listed!, widget.get(signature)!, options));
      if (!id) return;
      cacheSet(resolvedIds, 5000, originalId, id);
      pin.id = id;
      pin.url = `${WEB}/pin/${id}/`;
      if (listed) cacheSet(listedPins, 5000, id, { ...listed, pin: { ...pin } });
    } catch {
      checkCancelled(options);
    }
  }

  return { listedPins, rememberListed, resolvePinId, widgetPins, adoptRealId, pinDetails };
}
