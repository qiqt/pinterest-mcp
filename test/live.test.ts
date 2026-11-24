/**
 * Live Pinterest tests through MCP over stdio. Requires network access.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

type Block = { type: string; text?: string; data?: string; mimeType?: string };

const client = new Client({ name: 'live-test', version: '0.0.0' });

before(async () => {
  const server = path.join(import.meta.dirname, '..', 'src', 'server.ts');
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
});

after(() => client.close());

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const blocks = result.content as Block[];
  return {
    isError: result.isError === true,
    text: blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n'),
    images: blocks.filter((block) => block.type === 'image'),
  };
}

const imageUrls = (text: string) =>
  [...text.matchAll(/image: (https:\/\/i\.pinimg\.com\/\S+)/g)].map((match) => match[1]!);

test('lists the expected tools', async () => {
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
});

test('search_pins returns pins with thumbnails and paginates without repeats', async () => {
  const first = await call('search_pins', { query: 'brutalist architecture', limit: 8 });
  assert.equal(first.isError, false, first.text);
  const firstUrls = imageUrls(first.text);
  assert.equal(firstUrls.length, 8);
  assert.equal(first.images.length, 8);
  assert.ok(first.images.every((image) => image.mimeType === 'image/jpeg' && image.data!.length > 1000));

  const cursor = /cursor "(c\d+)"/.exec(first.text)?.[1];
  assert.ok(cursor, 'expected a continuation cursor');
  const second = await call('more_results', { cursor, limit: 8, preview: false });
  assert.equal(second.isError, false, second.text);
  assert.match(second.text, /^\[9\] /m);
  assert.equal(second.images.length, 0);
  const secondUrls = imageUrls(second.text);
  assert.equal(secondUrls.length, 8);
  assert.equal(new Set([...firstUrls, ...secondUrls]).size, 16);
});

test('board_pins recovers real pin IDs, which get_pin and related_pins accept', async () => {
  const board = await call('board_pins', { board: 'archeyesnews/brutalist-architecture', limit: 5, preview: false });
  assert.equal(board.isError, false, board.text);
  assert.match(board.text, /^Brutalist Architecture \(/);
  const pinUrl = /pin: (https:\/\/www\.pinterest\.com\/pin\/\d+\/)/.exec(board.text)?.[1];
  assert.ok(pinUrl, 'expected at least one pin with a real URL');

  const pin = await call('get_pin', { pin: pinUrl });
  assert.equal(pin.isError, false, pin.text);
  assert.match(pin.text, /image: https:\/\/i\.pinimg\.com\/originals\//);
  assert.equal(pin.images.length, 1);

  const related = await call('related_pins', { pin: pinUrl, limit: 5, preview: false });
  assert.equal(related.isError, false, related.text);
  assert.equal(imageUrls(related.text).length, 5);
});

test('pins with obfuscated IDs still support get_pin and related_pins', async () => {
  const search = await call('search_pins', { query: 'brutalist architecture', limit: 12, preview: false });
  const ids = [...search.text.matchAll(/^  id: (e1_[\w-]+)$/gm)].map((match) => match[1]!);
  assert.ok(ids.length > 0, 'expected logged-out search results to carry obfuscated IDs');

  // Include a page URL when ID recovery succeeds.
  const unrecovered: string[] = [];
  for (const id of ids) {
    const pin = await call('get_pin', { pin: id, preview: false });
    assert.equal(pin.isError, false, pin.text);
    assert.match(pin.text, /image: https:\/\/i\.pinimg\.com\//);
    if (!/pin: https:\/\/www\.pinterest\.com\/pin\/\d+\//.test(pin.text)) unrecovered.push(id);
  }
  assert.ok(unrecovered.length < ids.length, `none of ${ids.length} obfuscated IDs could be recovered`);

  // Deep lookups return details even when URL recovery fails.
  if (unrecovered[0]) {
    const pin = await call('get_pin', { pin: unrecovered[0], find_url: true, preview: false });
    assert.equal(pin.isError, false, pin.text);
    assert.match(pin.text, /image: https:\/\/i\.pinimg\.com\//);
  }

  // Check related pins for both resolved and hidden IDs.
  for (const id of ids.slice(0, 6)) {
    const related = await call('related_pins', { pin: id, limit: 5, preview: false });
    assert.equal(related.isError, false, related.text);
    assert.equal(imageUrls(related.text).length, 5, `related_pins returned too few results for ${id}`);
  }
});

test('related_pins runs a visual search on a bare image URL and paginates it', async () => {
  const search = await call('search_pins', { query: 'art deco poster', limit: 1, preview: false });
  const [imageUrl] = imageUrls(search.text);
  assert.ok(imageUrl);

  const first = await call('related_pins', { pin: imageUrl, limit: 10, preview: false });
  assert.equal(first.isError, false, first.text);
  const firstUrls = imageUrls(first.text);
  assert.equal(firstUrls.length, 10);
  // Visual-search results carry real pin IDs.
  assert.equal([...first.text.matchAll(/pin: https:\/\/www\.pinterest\.com\/pin\/\d+\//g)].length, 10);

  const cursor = /cursor "(c\d+)"/.exec(first.text)?.[1];
  assert.ok(cursor, 'expected a continuation cursor');
  const second = await call('more_results', { cursor, limit: 10, preview: false });
  assert.equal(second.isError, false, second.text);
  assert.equal(new Set([...firstUrls, ...imageUrls(second.text)]).size, 20);
});

test('get_pin gives video pins a direct MP4', async () => {
  const search = await call('search_pins', { query: 'pottery wheel throwing video', limit: 40, preview: false });
  const video = /^  video: \S+\.m3u8.*\n(?:  .*\n)*?  (?:id|pin): (\S+)/m.exec(search.text);
  assert.ok(video, 'expected at least one video pin in the results');
  const pin = await call('get_pin', { pin: video[1]!, preview: false });
  assert.equal(pin.isError, false, pin.text);
  assert.match(pin.text, /video: https:\/\/v1\.pinimg\.com\/\S+\.mp4/);
});

test('search_boards, user_profile, user_pins and suggest_queries respond', async () => {
  const boards = await call('search_boards', { query: 'japanese garden', limit: 3 });
  assert.equal(boards.isError, false, boards.text);
  assert.equal([...boards.text.matchAll(/^  board: https:\/\/www\.pinterest\.com\//gm)].length, 3);

  const profile = await call('user_profile', { user: '@archeyesnews', limit: 3 });
  assert.equal(profile.isError, false, profile.text);
  assert.match(profile.text, /^@archeyesnews - /);

  const pins = await call('user_pins', { user: 'archeyesnews', limit: 3, preview: false });
  assert.equal(pins.isError, false, pins.text);
  assert.equal([...pins.text.matchAll(/pin: https:\/\/www\.pinterest\.com\/pin\/\d+\//g)].length, 3);

  const suggestions = await call('suggest_queries', { term: 'cyberpunk' });
  assert.equal(suggestions.isError, false, suggestions.text);
  assert.match(suggestions.text, /cyberpunk/);
});

test('view_images and download_images fetch real image bytes', async () => {
  const search = await call('search_pins', { query: 'watercolor landscape', limit: 2, preview: false });
  const urls = imageUrls(search.text);
  assert.equal(urls.length, 2);

  const view = await call('view_images', { urls, size: '474x' });
  assert.equal(view.isError, false, view.text);
  assert.equal(view.images.length, 2);

  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-test-'));
  try {
    const download = await call('download_images', { urls, directory });
    assert.equal(download.isError, false, download.text);
    const files = await readdir(directory);
    assert.equal(files.length, 2);
    for (const file of files) assert.ok((await stat(path.join(directory, file))).size > 5000);

    // Repeated downloads preserve existing files.
    const again = await call('download_images', { urls, directory });
    assert.equal(again.isError, false, again.text);
    assert.equal([...again.text.matchAll(/^exists .*\(kept\)$/gm)].length, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('failures come back as readable tool errors', async () => {
  const missing = await call('get_pin', { pin: '99999999999999999' });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /Pin not found/);

  const foreign = await call('view_images', { urls: ['https://example.com/a.jpg'] });
  assert.equal(foreign.isError, true);
  assert.match(foreign.text, /Only https:\/\/…pinimg\.com image URLs/);
  assert.equal(foreign.images.length, 0);

  const nothingSaved = await call('download_images', { urls: ['https://example.com/a.jpg'] });
  assert.equal(nothingSaved.isError, true);
  assert.match(nothingSaved.text, /FAILED https:\/\/example\.com\/a\.jpg/);

  const expired = await call('more_results', { cursor: 'c999' });
  assert.equal(expired.isError, true);
  assert.match(expired.text, /Unknown or expired cursor/);
});
