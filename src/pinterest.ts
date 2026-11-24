import {
  type Pin,
  type Board,
  type User,
  type Page,
  type PageOptions,
  type RequestOptions,
  type Raw,
  PinterestError,
} from './types.ts';
import { isNumericId, isCdnUrl, parsePinId, parseBoardPath, parseUsername, queryText } from './parse.ts';
import { toPin, toBoard, toUser } from './normalize.ts';
import { WEB, USER_AGENT, resource, api, paginate, requestSignal, checkCancelled } from './transport.ts';
import { mapLimit, createSingleFlight } from './concurrency.ts';
import { errorMessage, validateLimit } from './transport.ts';
import { createResolver, cacheSet } from './resolve.ts';
export * from './types.ts';
export { isCdnUrl, parsePinId, parseBoardPath, parseUsername } from './parse.ts';
export { toPin, toBoard, toUser } from './normalize.ts';
export { USER_AGENT } from './transport.ts';

export function createClient() {
  const resolver = createResolver();
  const { listedPins, resolvePinId, widgetPins, adoptRealId } = resolver;
  const recordPin = (raw: Raw): Pin => {
    const pin = toPin(raw);
    resolver.rememberListed(pin, raw);
    return pin;
  };
  const pinsOf = (data: unknown): Pin[] =>
    (Array.isArray(data) ? data : []).filter((entry) => entry?.type === 'pin' && !entry.is_promoted).map(recordPin);
  /** Full-text pin search. */
  async function searchPins(query: string, options: PageOptions<Pin> = {}): Promise<Page<Pin>> {
    query = queryText(query);
    const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
    return paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await resource(
        'BaseSearchResource',
        { query, scope: 'pins', rs: 'typed', page_size: pageSize, ...(bookmark && { bookmarks: [bookmark] }) },
        sourceUrl,
        options,
      );
      return { items: pinsOf(data?.results), bookmark: next };
    }, options);
  }

  /** Search boards by name. */
  async function searchBoards(query: string, options: PageOptions<Board> = {}): Promise<Page<Board>> {
    query = queryText(query);
    const sourceUrl = `/search/boards/?q=${encodeURIComponent(query)}&rs=typed`;
    return paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await resource(
        'BaseSearchResource',
        { query, scope: 'boards', rs: 'typed', page_size: pageSize, ...(bookmark && { bookmarks: [bookmark] }) },
        sourceUrl,
        options,
      );
      const boards = (Array.isArray(data?.results) ? data.results : [])
        .filter((entry: Raw) => entry?.type === 'board')
        .map(toBoard);
      return { items: boards, bookmark: next };
    }, options);
  }

  /** Search-box autocomplete: popular queries starting with or related to `term`. */
  async function suggestQueries(term: string, options: RequestOptions = {}): Promise<string[]> {
    term = queryText(term);
    const { data } = await resource('AdvancedTypeaheadResource', { term, pin_scope: 'pins', count: 12 }, '/', options);
    const queries = (Array.isArray(data?.items) ? data.items : [])
      .filter((item: Raw) => item?.type === 'query' && typeof item.query === 'string')
      .map((item: Raw) => item.query as string);
    return [...new Set<string>(queries)];
  }

  /**
   * Check two CDN paths for an HLS stream's MP4. Returns undefined if neither exists.
   */
  async function directVideoUrl(streamUrl: string, options: RequestOptions = {}): Promise<string | undefined> {
    checkCancelled(options);
    const file = /\/((?:[0-9a-f]{2}\/){3}[0-9a-f]{32})/.exec(streamUrl)?.[1];
    if (!file || !isCdnUrl(streamUrl)) return undefined;
    const candidates = [
      `https://v1.pinimg.com/videos/iht/expMp4/${file}_720w.mp4`,
      `https://v1.pinimg.com/videos/iht/720p/${file}.mp4`,
    ];
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, {
          method: 'HEAD',
          headers: { 'User-Agent': USER_AGENT },
          signal: requestSignal(options, 10_000),
          redirect: 'error',
        });
        checkCancelled(options);
        if (response.ok && response.headers.get('content-type')?.toLowerCase().startsWith('video/')) return candidate;
      } catch {
        checkCancelled(options);
      }
    }
    return undefined;
  }

  async function withDirectVideo(pin: Pin, options: RequestOptions): Promise<Pin> {
    checkCancelled(options);
    if (!pin.video?.url.includes('.m3u8')) return pin;
    const mp4 = await directVideoUrl(pin.video.url, options);
    return mp4 ? { ...pin, video: { ...pin.video, url: mp4 } } : pin;
  }

  /**
   * Fetch pin details. Unresolved IDs return cached details without a page URL,
   * plus a save count when available. `deep` also searches the owner's saved pins.
   */
  async function getPin(pin: string, options: RequestOptions & { deep?: boolean } = {}): Promise<Pin> {
    checkCancelled(options);
    const id = parsePinId(pin);
    let numericId: string | undefined;
    try {
      numericId = await resolvePinId(id, options);
      return await withDirectVideo(recordPin(await resolver.pinDetails(numericId, options)), options);
    } catch (error) {
      checkCancelled(options);
      const listed = listedPins.get(numericId ?? id) ?? listedPins.get(id);
      if (!listed) throw error;
      const details: Pin = { ...listed.pin, warnings: [`Using cached pin details: ${errorMessage(error)}`] };
      if (numericId) {
        details.id = numericId;
        details.url = `${WEB}/pin/${numericId}/`;
      }
      if (listed.aggregatedId && details.saves === undefined) {
        const stats = await api(`/v3/aggregated_pin_data/${listed.aggregatedId}/`, {}, options).catch(() => {
          checkCancelled(options);
          return undefined;
        });
        const saves = stats?.data?.aggregated_stats?.saves;
        details.saves = typeof saves === 'number' && Number.isFinite(saves) ? saves : undefined;
      }
      return withDirectVideo(details, options);
    }
  }

  const SIMILAR_FIELDS =
    'pin.id,pin.title,pin.grid_title,pin.description,pin.auto_alt_text,pin.images[orig,236x],pin.dominant_color,' +
    'pin.image_signature,pin.link,pin.domain,pin.created_at,pin.videos,pin.aggregated_pin_data(),pin.pinner(),' +
    'user.username,user.full_name';

  /**
   * Find similar pins from a Pinterest image URL. Results include numeric pin IDs.
   */
  async function similarPins(imageUrl: string, options: PageOptions<Pin> = {}): Promise<Page<Pin>> {
    const url = imageUrl.trim();
    if (!isCdnUrl(url)) {
      throw new PinterestError(400, `Visual search only works on https://…pinimg.com image URLs, got "${imageUrl}"`);
    }
    return paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await api(
        '/v3/visual_search/flashlight/url/',
        {
          url,
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          // This endpoint returns roughly half the page size it is asked for.
          page_size: Math.min(100, pageSize * 2),
          fields: SIMILAR_FIELDS,
          ...(bookmark && { bookmark }),
        },
        options,
      );
      return { items: (Array.isArray(data) ? data : []).filter((entry) => entry?.id).map(recordPin), bookmark: next };
    }, options);
  }

  /**
   * Find similar pins by ID, pin URL or image URL. Use the related feed when the
   * numeric ID is available through the default lookup; otherwise use visual search.
   */
  async function relatedPins(pin: string, options: PageOptions<Pin> = {}): Promise<Page<Pin>> {
    validateLimit(options.limit ?? 25);
    checkCancelled(options);
    // A continuation must stay on the backend that issued its bookmark.
    let via = options.cursor?.via ?? (await relatedSource(pin, options));
    const target = via.slice(via.indexOf(':') + 1);
    let page = via.startsWith('image:')
      ? await similarPins(target, options)
      : await paginate(async (pageSize, bookmark) => {
          const { data, bookmark: next } = await resource(
            'RelatedPinFeedResource',
            { pin: target, page_size: pageSize, ...(bookmark && { bookmarks: [bookmark] }) },
            `/pin/${target}/`,
            options,
          );
          return { items: pinsOf(data), bookmark: next };
        }, options);
    // Try visual search if the related feed is empty.
    const imageUrl = options.cursor || isCdnUrl(pin) ? undefined : listedPins.get(parsePinId(pin))?.pin.image?.url;
    if (page.items.length === 0 && !options.cursor && via.startsWith('feed:') && imageUrl) {
      via = `image:${imageUrl}`;
      page = await similarPins(imageUrl, options);
    }
    return { items: page.items, next: page.next && { ...page.next, via } };
  }

  async function relatedSource(input: string, options: RequestOptions): Promise<string> {
    if (isCdnUrl(input)) return `image:${input.trim()}`;
    const id = parsePinId(input);
    try {
      return `feed:${await resolvePinId(id, options)}`;
    } catch (error) {
      checkCancelled(options);
      const imageUrl = listedPins.get(id)?.pin.image?.url;
      if (!imageUrl) throw error;
      return `image:${imageUrl}`;
    }
  }

  const boardCache = new Map<string, { board: Board; expires: number }>();
  const boardRequests = createSingleFlight<string, Board>();
  async function getBoard(board: string, options: RequestOptions = {}): Promise<Board> {
    checkCancelled(options);
    const path = parseBoardPath(board);
    const cached = boardCache.get(path);
    if (cached && cached.expires > Date.now()) return cached.board;
    return boardRequests(path, options.signal, async (signal) => {
      const [username, slug] = path.split('/').filter(Boolean).map(decodeURIComponent);
      const { data } = await resource('BoardResource', { username, slug, field_set_key: 'detailed' }, path, { signal });
      const result = toBoard(data);
      cacheSet(boardCache, 200, path, { board: result, expires: Date.now() + 300_000 });
      return result;
    });
  }

  /**
   * List pins in board order. Match numeric IDs from the board's 50 newest widget pins.
   */
  async function boardPins(board: string, options: PageOptions<Pin> = {}): Promise<Page<Pin> & { board: Board }> {
    validateLimit(options.limit ?? 25);
    const info = await getBoard(board, options);
    const path = parseBoardPath(info.url);
    const realIds = await widgetPins(`boards${path}pins/`, options).catch(() => {
      checkCancelled(options);
      return new Map<string, string[]>();
    });
    const page = await paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await resource(
        'BoardFeedResource',
        {
          board_id: info.id,
          board_url: path,
          currentFilter: -1,
          field_set_key: 'grid_item',
          filter_section_pins: true,
          sort: 'default',
          layout: 'default',
          page_size: pageSize,
          ...(bookmark && { bookmarks: [bookmark] }),
        },
        path,
        options,
      );
      return { items: pinsOf(data), bookmark: next };
    }, options);
    await mapLimit(page.items, 4, (pin) => adoptRealId(pin, realIds, options));
    return { board: info, ...page };
  }

  async function getUser(user: string, options: RequestOptions = {}): Promise<User> {
    const username = parseUsername(user);
    const { data } = await resource(
      'UserResource',
      { username, field_set_key: 'unauth_profile' },
      `/${encodeURIComponent(username)}/`,
      options,
    );
    return toUser(data);
  }

  /** List public boards by most recent save. */
  async function userBoards(user: string, options: PageOptions<Board> = {}): Promise<Page<Board>> {
    const username = parseUsername(user);
    return paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await resource(
        'BoardsResource',
        {
          username,
          page_size: pageSize,
          privacy_filter: 'all',
          sort: 'last_pinned_to',
          field_set_key: 'profile_grid_item',
          include_archived: true,
          ...(bookmark && { bookmarks: [bookmark] }),
        },
        `/${encodeURIComponent(username)}/`,
        options,
      );
      const boards = (Array.isArray(data) ? data : []).filter((entry) => entry?.type === 'board').map(toBoard);
      return { items: boards, bookmark: next };
    }, options);
  }

  /** List a user's pins with numeric IDs, newest first. */
  async function userPins(user: string, options: PageOptions<Pin> = {}): Promise<Page<Pin>> {
    const username = parseUsername(user);
    return paginate(async (pageSize, bookmark) => {
      const { data, bookmark: next } = await resource(
        'UserPinsResource',
        { username, page_size: pageSize, field_set_key: 'grid_item', ...(bookmark && { bookmarks: [bookmark] }) },
        `/${encodeURIComponent(username)}/pins/`,
        options,
      );
      return { items: pinsOf(data), bookmark: next };
    }, options);
  }

  return {
    searchPins,
    searchBoards,
    suggestQueries,
    directVideoUrl,
    getPin,
    similarPins,
    relatedPins,
    getBoard,
    boardPins,
    getUser,
    userBoards,
    userPins,
    resolvePinId,
  };
}
export const {
  searchPins,
  searchBoards,
  suggestQueries,
  directVideoUrl,
  getPin,
  similarPins,
  relatedPins,
  getBoard,
  boardPins,
  getUser,
  userBoards,
  userPins,
  resolvePinId,
} = createClient();
