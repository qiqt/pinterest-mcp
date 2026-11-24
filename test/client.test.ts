import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, toPin, toBoard, toUser, PinterestError } from '../src/pinterest.ts';
import { paginate, fetchJson, resource } from '../src/transport.ts';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const envelope = (data: unknown, bookmark?: string) => json({ resource_response: { data, bookmark } });
const hash = 'a'.repeat(32);
const image = `https://i.pinimg.com/originals/aa/aa/aa/${hash}.jpg`;
const raw = (id: string, created = '2025-01-01T00:00:00Z') => ({
  type: 'pin',
  id,
  created_at: created,
  title: id,
  image_signature: hash,
  images: { orig: { url: image, width: 100, height: 100 } },
  board: { name: 'Board', url: '/user/board/' },
  pinner: { username: 'user' },
});

test('ID recovery normalizes board paths and skips malformed widget entries', async (t) => {
  for (const [listedPath, candidatePath, expectedPath] of [
    ['https://www.pinterest.com/user/board/', '/user/board/', '/user/board/'],
    ['/user/königsberg/', '/user/k%C3%B6nigsberg/', '/user/k%C3%B6nigsberg/'],
    ['/user/k%C3%B6nigsberg/', '/user/königsberg/', '/user/k%C3%B6nigsberg/'],
  ]) {
    const widgetPaths: string[] = [];
    const mock = t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.hostname.startsWith('widgets')) {
        widgetPaths.push(url.pathname);
        return json({ data: { pins: [null, 7, raw('111')] } });
      }
      if (url.pathname.includes('BaseSearchResource'))
        return envelope({ results: [{ ...raw('e1_test'), board: { url: listedPath } }] });
      if (url.pathname.includes('PinResource')) return envelope({ ...raw('111'), board: { url: candidatePath } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const client = createClient();
    await client.searchPins('test', { limit: 1 });
    assert.equal(await client.resolvePinId('e1_test'), '111');
    assert.deepEqual(widgetPaths, [`/v3/pidgets/boards${expectedPath}pins/`]);
    mock.mock.restore();
  }
});

test('invalid upstream board URLs do not produce widget requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    envelope({ results: [{ ...raw('e1_invalid'), board: { url: { invalid: true } } }] }),
  );
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  await assert.rejects(client.resolvePinId('e1_invalid'), /Could not recover/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('cancellation from the last recovery progress callback keeps the abort reason', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('widgets.')) return json({ data: { pins: [] } });
    if (url.includes('BaseSearchResource')) return envelope({ results: [raw('e1_cancel')] });
    if (url.includes('UserPinsResource'))
      return envelope([{ seo_url: '/pin/222/', created_at: '2024-01-01T00:00:00Z' }]);
    throw new Error(`Unexpected request: ${url}`);
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  const controller = new AbortController();
  const reason = new Error('USER_CANCELLED');
  await assert.rejects(
    client.resolvePinId('e1_cancel', {
      deep: true,
      signal: controller.signal,
      onProgress: () => controller.abort(reason),
    }),
    (error) => error === reason,
  );
  await assert.rejects(
    client.directVideoUrl('https://example.com/foo.m3u8', {
      signal: controller.signal,
    }),
    (error) => error === reason,
  );
});

test('pagination crosses filtered pages and preserves a continuation at the request cap', async () => {
  let calls = 0;
  const result = await paginate(async () => ({ items: ++calls < 3 ? [] : ['found'], bookmark: `p${calls}` }), {
    limit: 1,
  });
  assert.deepEqual(result.items, ['found']);
  assert.equal(calls, 3);
  calls = 0;
  const capped = await paginate(async () => ({ items: [], bookmark: `p${++calls}` }), { limit: 1 });
  assert.equal(calls, 8);
  assert.equal(capped.next?.bookmark, 'p8');
});

test('pagination handles buffers, repeated bookmarks, and invalid limits', async () => {
  const buffered = await paginate(
    async () => {
      throw new Error('Unexpected request');
    },
    { limit: 2, cursor: { buffer: [1, 2, 3] } },
  );
  assert.deepEqual(buffered, { items: [1, 2], next: { bookmark: undefined, buffer: [3] } });
  let calls = 0;
  const stopped = await paginate(
    async () => {
      calls++;
      return { items: [], bookmark: 'same' };
    },
    { limit: 1, cursor: { buffer: [], bookmark: 'same' } },
  );
  assert.equal(stopped.next, undefined);
  assert.equal(calls, 1);
  for (const limit of [0, -1, NaN, 1.5, 101])
    await assert.rejects(
      paginate(async () => ({ items: [] }), { limit }),
      /Limit/,
    );
});

test('malformed upstream JSON and pin data produce useful errors', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json(null));
  await assert.rejects(fetchJson('https://example.test', {}), PinterestError);
  assert.throws(() => toPin(null as never), PinterestError);
  assert.throws(() => toPin({}), /Invalid.*ID/);
  assert.equal(toPin({ ...raw('123'), pin_join: { visual_annotation: 'invalid' } }).tags, undefined);
  assert.equal(toBoard({ id: '1', url: '/u/b/', pin_count: 'wrong', image_cover_url: {} }).pins, undefined);
  assert.equal(toUser({ username: 'user', follower_count: {}, image_xlarge_url: [] }).avatar, undefined);
});

test('a deleted candidate does not prevent verification of another save', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('widgets')) return json({ data: { pins: [raw('111'), raw('222')] } });
    if (url.pathname.includes('BaseSearchResource')) return envelope({ results: [raw('e1_deleted')] });
    const id = JSON.parse(url.searchParams.get('data')!).options.id;
    return id === '111'
      ? json({ resource_response: { error: { message: 'Deleted', http_status: 404 } } }, 404)
      : envelope(raw(id));
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  assert.equal((await client.getPin('e1_deleted')).id, '222');
});

test('deep recovery checks candidates across a page boundary', async (t) => {
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('widgets')) return json({ data: { pins: [] } });
    if (url.pathname.includes('BaseSearchResource')) return envelope({ results: [raw('e1_boundary')] });
    if (url.pathname.includes('UserPinsResource')) {
      pages++;
      return envelope(
        [{ seo_url: `/pin/${pages === 1 ? '111' : '222'}/`, created_at: '2025-01-01T00:00:00Z' }],
        pages === 1 ? 'next' : undefined,
      );
    }
    const id = JSON.parse(url.searchParams.get('data')!).options.id;
    return envelope({ ...raw(id), image_signature: id === '111' ? 'b'.repeat(32) : hash });
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  assert.equal((await client.getPin('e1_boundary', { deep: true })).id, '222');
  assert.equal(pages, 2);
});

test('cancellation during progress and retry delays stops further work', async (t) => {
  const controller = new AbortController();
  await assert.rejects(
    paginate(async () => ({ items: ['found'] }), {
      limit: 1,
      signal: controller.signal,
      onProgress: () => controller.abort(new Error('Stopped at progress')),
    }),
    /Stopped at progress/,
  );
  const retryController = new AbortController();
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    setImmediate(() => retryController.abort());
    return new Response('', { status: 429, headers: { 'retry-after': '10' } });
  });
  await assert.rejects(fetchJson('https://example.test', {}, { signal: retryController.signal }));
  assert.equal(fetch.mock.callCount(), 1);
});

test('transient HTTP failures retry successfully', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () =>
    ++calls === 1 ? new Response('', { status: 500 }) : json({ ok: true }),
  );
  const result = await fetchJson('https://example.test', {});
  assert.equal(result.body.ok, true);
  assert.equal(calls, 2);
});

test('search rejects blank queries without requests', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Unexpected request');
  });
  await assert.rejects(createClient().searchPins('   '), /blank/);
  assert.equal(fetch.mock.callCount(), 0);
});

test('widget matches use creation time and reject ambiguous saves', async (t) => {
  let ambiguous = false;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('widgets')) return json({ data: { pins: [raw('111'), raw('222')] } });
    if (url.pathname.includes('BaseSearchResource')) return envelope({ results: [raw('e1_hidden')] });
    const id = JSON.parse(url.searchParams.get('data')!).options.id;
    return envelope(raw(id, id === '111' && !ambiguous ? '2026-01-01T00:00:00Z' : '2025-01-01T00:00:00Z'));
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  assert.equal((await client.getPin('e1_hidden')).id, '222');
  ambiguous = true;
  const another = createClient();
  await another.searchPins('test', { limit: 1 });
  const unresolved = await another.getPin('e1_hidden');
  assert.equal(unresolved.id, 'e1_hidden');
  assert.match(unresolved.warnings![0]!, /cached/);
});

test('deep recovery reuses verified details and keeps the ID after a refresh failure', async (t) => {
  let detailCalls = 0,
    fail = false,
    now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('widgets.')) return json({ data: { pins: [] } });
    if (url.includes('BaseSearchResource')) return envelope({ results: [raw('e1_deep')] });
    if (url.includes('UserPinsResource'))
      return envelope([{ seo_url: '/pin/222/', created_at: '2025-01-01T00:00:00Z' }]);
    detailCalls++;
    return fail ? json({ resource_response: { error: { message: 'Unavailable' } } }, 404) : envelope(raw('222'));
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  assert.equal((await client.getPin('e1_deep', { deep: true })).id, '222');
  assert.equal(detailCalls, 1);
  now = 300_001;
  fail = true;
  const cached = await client.getPin('e1_deep');
  assert.equal(cached.id, '222');
  assert.equal(cached.title, '222');
  assert.equal(cached.url, 'https://www.pinterest.com/pin/222/');
  assert.match(cached.warnings![0]!, /Unavailable/);
  await assert.rejects(createClient().getPin('e1_deep'), /unavailable in this session/);
});

test('cancellation stops requests and is never converted to cached success', async (t) => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls++;
    controller.abort(new Error('Stopped'));
    init.signal!.throwIfAborted();
    return envelope({ results: [] });
  });
  await assert.rejects(createClient().searchPins('test', { signal: controller.signal }), /Stopped/);
  assert.equal(calls, 1);
});

test('retry-after longer than the request budget returns without retrying early', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 429, headers: { 'retry-after': '60' } }),
  );
  await assert.rejects(fetchJson('https://example.test', {}), /429/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('board ID adoption uses the canonical path and shares candidate detail requests', async (t) => {
  const widgetPaths: string[] = [];
  const detailIds: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    await new Promise((resolve) => setImmediate(resolve));
    if (url.hostname.startsWith('widgets')) {
      widgetPaths.push(url.pathname);
      return json({ data: { pins: [raw('111'), raw('222')] } });
    }
    if (url.pathname.includes('BoardResource')) return envelope({ id: '1', name: 'Board', url: '/user/board/' });
    if (url.pathname.includes('BoardFeedResource'))
      return envelope([raw('e1_old'), raw('e1_new', '2026-01-01T00:00:00Z')]);
    const id = JSON.parse(url.searchParams.get('data')!).options.id;
    detailIds.push(id);
    return envelope(raw(id, id === '111' ? '2025-01-01T00:00:00Z' : '2026-01-01T00:00:00Z'));
  });
  const page = await createClient().boardPins('User/Board', { limit: 2 });
  assert.deepEqual(
    page.items.map((pin) => pin.id),
    ['111', '222'],
  );
  assert.deepEqual(widgetPaths, ['/v3/pidgets/boards/user/board/pins/']);
  assert.deepEqual(detailIds, ['111', '222']);
});

test('deep recovery survives widget failures and serializes user pages with undated rows', async (t) => {
  let pages = 0;
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    await new Promise((resolve) => setImmediate(resolve));
    if (url.hostname.startsWith('widgets')) return json({}, 403);
    if (url.pathname.includes('BaseSearchResource'))
      return envelope({ results: [raw('e1_old'), raw('e1_new', '2025-06-01T00:00:00Z')] });
    if (url.pathname.includes('UserPinsResource')) {
      pages++;
      return pages === 1
        ? envelope([{ seo_url: '/pin/222/', created_at: '2025-06-01T00:00:00Z' }, { type: 'story' }], 'next')
        : envelope([{ seo_url: '/pin/111/', created_at: '2025-01-01T00:00:00Z' }, { type: 'story' }]);
    }
    const id = JSON.parse(url.searchParams.get('data')!).options.id;
    return envelope(raw(id, id === '111' ? '2025-01-01T00:00:00Z' : '2025-06-01T00:00:00Z'));
  });
  const client = createClient();
  await client.searchPins('test', { limit: 2 });
  const ids = await Promise.all([
    client.resolvePinId('e1_new', { deep: true }),
    client.resolvePinId('e1_old', { deep: true }),
  ]);
  assert.deepEqual(ids, ['222', '111']);
  assert.equal(pages, 2);
});

test('HTTP error bodies are cancelled, Retry-After is trimmed, and 4xx status survives missing envelopes', async (t) => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 429 },
  );
  t.mock.method(response.headers, 'get', () => ' 60 ');
  const fetch = t.mock.method(globalThis, 'fetch', async () => response);
  await assert.rejects(fetchJson('https://example.test', {}), /429/);
  assert.equal(cancelled, true);
  assert.equal(fetch.mock.callCount(), 1);
  fetch.mock.mockImplementation(async () => json({}, 404));
  await assert.rejects(
    resource('PinResource', {}, '/'),
    (error) => error instanceof PinterestError && error.status === 404,
  );
});

test('403 resource retries succeed and related pagination stays on visual search', async (t) => {
  let retries = 0,
    visual = 0;
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    ++retries === 1 ? json({ resource_response: { error: { message: 'retry' } } }, 403) : envelope({ ok: true }),
  );
  assert.deepEqual((await resource('ExampleResource', {}, '/')).data, { ok: true });
  assert.equal(retries, 2);
  fetch.mock.mockImplementation(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('BaseSearchResource')) return envelope({ results: [raw('111')] });
    if (url.includes('RelatedPinFeedResource')) return envelope([]);
    if (url.includes('ApiResource')) {
      visual++;
      return envelope([raw(String(300 + visual))], visual === 1 ? 'next' : undefined);
    }
    throw new Error('Unexpected request');
  });
  const client = createClient();
  await client.searchPins('test', { limit: 1 });
  const first = await client.relatedPins('111', { limit: 1 });
  assert.ok(first.next?.via?.startsWith('image:'));
  const second = await client.relatedPins('', { limit: 1, cursor: first.next });
  assert.equal(second.items[0]!.id, '302');
  assert.equal(visual, 2);
});
