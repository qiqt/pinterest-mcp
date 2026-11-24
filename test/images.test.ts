import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, open, readFile, readdir, rm, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchImage, downloadImages, fileNameFor } from '../src/images.ts';
import { imageBlocks } from '../src/mcp-output.ts';
const url = 'https://i.pinimg.com/originals/aa/bb/cc/abc.jpg';

test('concurrent downloads publish complete files without overwriting each other', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probePath = path.join(directory, 'probe');
  const probe = await open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const write = prototype.writeFile;
  await probe.close();
  await unlink(probePath);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  t.mock.method(
    prototype,
    'writeFile',
    async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
      started.resolve();
      await release.promise;
      return write.apply(this, args);
    },
  );
  const bytes = 'complete image'.repeat(5000);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'content-type': 'image/jpeg' } }));
  const first = downloadImages([url], directory);
  await started.promise;
  try {
    assert.equal(existsSync(path.join(directory, fileNameFor(url))), false);
  } finally {
    release.resolve();
  }
  const second = downloadImages([url], directory);
  const results = (await Promise.all([first, second])).flat();
  assert.equal(results.filter((result) => result.existing).length, 1);
  for (const result of results) {
    assert.equal(result.error, undefined);
    assert.equal(await readFile(result.path!, 'utf8'), bytes);
  }
  assert.deepEqual(await readdir(directory), [fileNameFor(url)]);
});

test('failed writes leave neither a published file nor a temporary file', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-write-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const probePath = path.join(directory, 'probe');
  const probe = await open(probePath, 'wx');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const write = prototype.writeFile;
  await probe.close();
  await unlink(probePath);
  t.mock.method(prototype, 'writeFile', async function (this: FileHandle) {
    await write.call(this, 'partial');
    throw new Error('Disk write failed');
  });
  t.mock.method(globalThis, 'fetch', async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }));
  const result = await downloadImages([url], directory);
  assert.match(result[0]!.error!, /Disk write failed/);
  assert.deepEqual(await readdir(directory), []);
});

test('image requests validate redirects before following them', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 302, headers: { location: 'https://example.com/image.jpg' } }),
  );
  await assert.rejects(fetchImage(url), /redirected away/);
  assert.equal(fetch.mock.callCount(), 1);
});

test('image errors cancel unread bodies and MIME matching ignores case', async (t) => {
  let cancelled = false;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 500 },
      ),
  );
  await assert.rejects(fetchImage(url), /500/);
  assert.equal(cancelled, true);
  fetch.mock.mockImplementation(async () => new Response('bytes', { headers: { 'content-type': 'IMAGE/JPEG' } }));
  assert.equal((await fetchImage(url)).mimeType, 'image/jpeg');
});

test('preview byte limits stop streaming and keep combined responses bounded', async (t) => {
  let cancelled = false;
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/jpeg' } },
      ),
  );
  await assert.rejects(fetchImage(url, '736x', { maxBytes: 8 }), /size limit/);
  assert.equal(cancelled, true);
  let active = 0,
    peak = 0;
  fetch.mock.mockImplementation(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setImmediate(resolve));
    active--;
    return new Response(new Uint8Array(1024 * 1024), { headers: { 'content-type': 'image/jpeg' } });
  });
  const result = await imageBlocks(Array(8).fill(url), '736x', {});
  assert.ok(peak <= 4);
  assert.equal(result.images.filter((image) => image.shown).length, 4);
  assert.ok(
    Buffer.byteLength(JSON.stringify({ content: result.content, images: result.images, warnings: result.warnings })) <
      8 * 1024 * 1024,
  );
  assert.equal(fetch.mock.callCount(), 6); // One streaming-limit probe, then five bounded preview fetches.
  assert.equal(result.warnings.length, 4);
});

test('downloads normalize duplicates and preserve existing files', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-offline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('original bytes', { headers: { 'content-type': 'image/jpeg' } }),
  );
  const first = await downloadImages([url, ` ${url} `], directory);
  assert.equal(first.length, 1);
  assert.equal((await readdir(directory)).length, 1);
  const again = await downloadImages([url], directory);
  assert.equal(again[0]!.existing, true);
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(await readFile(first[0]!.path!, 'utf8'), 'original bytes');
});

test('invalid directories and filenames fail before download', async () => {
  await assert.rejects(downloadImages([url], '  '), /blank/);
  for (const value of ['https://i.pinimg.com/a:b/foo.jpg', 'https://i.pinimg.com/originals/CON.jpg'])
    assert.throws(() => fileNameFor(value), /Invalid/);
});

test('invalid byte limits are rejected before fetching and redirects have a hop limit', async (t) => {
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('', { status: 302, headers: { location: url } }),
  );
  for (const maxBytes of [NaN, Infinity, 0, -1, 1.5])
    await assert.rejects(fetchImage(url, 'original', { maxBytes }), /positive integer/);
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(fetchImage(url), /too many times/);
  assert.equal(fetch.mock.callCount(), 4);
});

test('filename collisions and a file created during download preserve existing bytes', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-race-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, fileNameFor(url));
  t.mock.method(globalThis, 'fetch', async () => {
    await writeFile(filename, 'external file');
    return new Response('downloaded bytes', { headers: { 'content-type': 'image/jpeg' } });
  });
  const result = await downloadImages([url, url.replace('/aa/bb/cc/', '/dd/ee/ff/')], directory);
  assert.equal(result[0]!.existing, true);
  assert.match(result[1]!.error!, /same file name/);
  assert.equal(await readFile(filename, 'utf8'), 'external file');
});

test('cancelling a download batch prevents queued files from starting', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'pinterest-cancel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const fetch = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('image', { headers: { 'content-type': 'image/jpeg' } }),
  );
  const urls = Array.from({ length: 12 }, (_, i) => url.replace('abc.jpg', `image${i}.jpg`));
  await assert.rejects(
    downloadImages(urls, directory, { signal: controller.signal, onProgress: () => controller.abort() }),
  );
  assert.ok(fetch.mock.callCount() <= 6);
  for (const file of await readdir(directory))
    assert.equal(await readFile(path.join(directory, file), 'utf8'), 'image');
});
