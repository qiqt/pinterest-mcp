import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../src/mcp.ts';

async function connect(t: TestContext) {
  const server = createServer();
  const client = new Client({ name: 'offline-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  t.after(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

test('MCP preserves its tools and returns structured listings, cursors, and progress', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          resource_response: {
            data: {
              results: [
                { type: 'pin', id: '123', title: 'First' },
                { type: 'pin', id: '456', title: 'Second' },
              ],
            },
          },
        }),
      ),
  );
  const client = await connect(t);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'board_pins',
    'download_images',
    'get_pin',
    'more_results',
    'related_pins',
    'search_boards',
    'search_pins',
    'suggest_queries',
    'user_pins',
    'user_profile',
    'view_images',
  ]);
  assert.ok(tools.every((tool) => tool.outputSchema));
  const progress: number[] = [];
  const first = await client.callTool(
    { name: 'search_pins', arguments: { query: 'poster', limit: 1, preview: false } },
    undefined,
    { onprogress: (value) => progress.push(value.progress) },
  );
  assert.equal(first.isError, undefined);
  const data = first.structuredContent as { items: { id: string }[]; nextCursor: string };
  assert.equal(data.items[0]!.id, '123');
  assert.equal(data.nextCursor, 'c1');
  assert.deepEqual(progress, [1]);
  const next = await client.callTool({
    name: 'more_results',
    arguments: { cursor: data.nextCursor, limit: 1, preview: false },
  });
  assert.equal((next.structuredContent as { items: { id: string }[] }).items[0]!.id, '456');
  assert.match(JSON.stringify(next.content), /\[2\]/);
  const other = await connect(t);
  assert.equal((await other.callTool({ name: 'more_results', arguments: { cursor: 'c1' } })).isError, true);
});

test('MCP rejects blank inputs and keeps partial image failures visible', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }));
  const client = await connect(t);
  const blank = await client.callTool({ name: 'search_pins', arguments: { query: '   ' } });
  assert.equal(blank.isError, true);
  const partial = await client.callTool({
    name: 'view_images',
    arguments: { urls: ['https://i.pinimg.com/originals/a.jpg', 'https://example.com/no.jpg'] },
  });
  assert.equal(partial.isError, false);
  const data = partial.structuredContent as { images: { shown: boolean }[]; warnings: string[] };
  assert.deepEqual(
    data.images.map((image) => image.shown),
    [true, false],
  );
  assert.equal(data.warnings.length, 1);
  const all = await client.callTool({ name: 'view_images', arguments: { urls: ['https://example.com/no.jpg'] } });
  assert.equal(all.isError, true);
});

test('MCP cancellation reaches the pending HTTP request', async (t) => {
  const controller = new AbortController();
  let resolveStarted!: () => void, resolveAborted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const aborted = new Promise<void>((resolve) => {
    resolveAborted = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    resolveStarted();
    return new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener(
        'abort',
        () => {
          resolveAborted();
          reject(init.signal!.reason);
        },
        { once: true },
      );
    });
  });
  const client = await connect(t);
  const pending = client.callTool({ name: 'search_pins', arguments: { query: 'poster', preview: false } }, undefined, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await rejected;
  await aborted;
});

test('thumbnails stay beside their numbered pins when a thumbnail is missing', async (t) => {
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    if (String(input).includes('pinimg.com'))
      return new Response('image', { headers: { 'content-type': 'image/jpeg' } });
    return new Response(
      JSON.stringify({
        resource_response: {
          data: {
            results: [1, 2, 3].map((id) => ({
              type: 'pin',
              id: String(id),
              title: String(id),
              images: id === 2 ? {} : { '236x': { url: 'https://i.pinimg.com/236x/a' + id + '.jpg' } },
            })),
          },
        },
      }),
    );
  });
  const client = await connect(t);
  const result = await client.callTool({ name: 'search_pins', arguments: { query: 'poster', limit: 3 } });
  const blocks = result.content as { type: string; text?: string }[];
  assert.deepEqual(
    blocks.map((block) => block.type),
    ['text', 'image', 'text', 'text', 'image', 'text'],
  );
  assert.match(blocks[0]!.text!, /^\[1\]/);
  assert.match(blocks[2]!.text!, /^\[2\]/);
  assert.match(blocks[3]!.text!, /^\[3\]/);
});

test('all MCP tool results validate, including board cursors and cached details', async (t) => {
  const rawPin = (id: string) => ({
    type: 'pin',
    id,
    title: id,
    images: { orig: { url: 'https://i.pinimg.com/originals/a.jpg', width: 100, height: 100 } },
  });
  const board = { type: 'board', id: '1', name: 'Board', url: '/user/board/' };
  const response = (data: unknown) => new Response(JSON.stringify({ resource_response: { data } }));
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname.endsWith('pinimg.com'))
      return new Response('image', { headers: { 'content-type': 'image/jpeg' } });
    if (url.hostname.startsWith('widgets')) return new Response(JSON.stringify({ data: { pins: [] } }));
    const options = JSON.parse(url.searchParams.get('data')!).options;
    if (url.pathname.includes('BaseSearchResource'))
      return response({
        results:
          options.scope === 'boards'
            ? [board, { ...board, id: '2' }]
            : [{ ...rawPin('e1_cached'), aggregated_pin_data: { id: '7' } }],
      });
    if (url.pathname.includes('BoardResource')) return response(board);
    if (url.pathname.includes('BoardsResource')) return response([board, { ...board, id: '2' }]);
    if (url.pathname.includes('UserResource')) return response({ username: 'user', full_name: 'User' });
    if (url.pathname.includes('AdvancedTypeaheadResource'))
      return response({ items: [{ type: 'query', query: 'poster art' }] });
    if (url.pathname.includes('PinResource')) return response(rawPin(options.id));
    if (url.pathname.includes('ApiResource')) return response({ aggregated_stats: { saves: 'not-a-number' } });
    return response([rawPin('111'), rawPin('222')]);
  });
  const client = await connect(t);
  for (const [name, args] of [
    ['search_boards', { query: 'art', limit: 1 }],
    ['board_pins', { board: 'user/board', limit: 1, preview: false }],
    ['user_profile', { user: 'user', limit: 1 }],
    ['user_pins', { user: 'user', limit: 1, preview: false }],
    ['related_pins', { pin: '111', limit: 1, preview: false }],
    ['suggest_queries', { term: 'art' }],
    ['get_pin', { pin: '111', preview: false }],
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    assert.ok(result.structuredContent);
    const cursor = (result.structuredContent as { nextCursor?: string }).nextCursor;
    if (cursor)
      assert.notEqual(
        (await client.callTool({ name: 'more_results', arguments: { cursor, limit: 1, preview: false } })).isError,
        true,
      );
  }
  await client.callTool({ name: 'search_pins', arguments: { query: 'hidden', limit: 1, preview: false } });
  const cached = await client.callTool({ name: 'get_pin', arguments: { pin: 'e1_cached', preview: false } });
  assert.notEqual(cached.isError, true);
  const data = cached.structuredContent as { pin: { saves?: number }; warnings: string[] };
  assert.equal(data.pin.saves, undefined);
  assert.equal(data.warnings.length, 1);
  assert.equal((JSON.stringify(cached.content).match(/Using cached pin details/g) ?? []).length, 1);

  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-mcp-'));
  const previousDirectory = process.cwd(),
    previousEnv = process.env.PINTEREST_DOWNLOAD_DIR;
  try {
    process.chdir(directory);
    process.env.PINTEREST_DOWNLOAD_DIR = '';
    const partial = await client.callTool({
      name: 'download_images',
      arguments: { urls: ['https://i.pinimg.com/originals/a.jpg', 'https://example.com/b.jpg'] },
    });
    assert.equal(partial.isError, false);
    const saved = (partial.structuredContent as { saved: { path?: string; error?: string }[] }).saved;
    assert.equal(saved[0]!.path, path.join(directory, 'pinterest-downloads', 'a.jpg'));
    assert.ok(saved[1]!.error);
    const failed = await client.callTool({
      name: 'download_images',
      arguments: { urls: ['https://example.com/b.jpg'] },
    });
    assert.equal(failed.isError, true);
    assert.ok(failed.structuredContent);
  } finally {
    process.chdir(previousDirectory);
    if (previousEnv === undefined) delete process.env.PINTEREST_DOWNLOAD_DIR;
    else process.env.PINTEREST_DOWNLOAD_DIR = previousEnv;
    await rm(directory, { recursive: true, force: true });
  }
});

test('oversized structured results return a small tool error', async (t) => {
  t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          resource_response: {
            data: { results: [{ type: 'pin', id: '1', description: 'x'.repeat(9 * 1024 * 1024) }] },
          },
        }),
      ),
  );
  const client = await connect(t);
  const result = await client.callTool({ name: 'search_pins', arguments: { query: 'test', limit: 1, preview: false } });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.content), /too large/);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1000);
});
