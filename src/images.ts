/** Fetching and saving images from Pinterest's CDN (pinimg.com). */

import { existsSync } from 'node:fs';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isCdnUrl } from './parse.ts';
import { PinterestError, type RequestOptions } from './types.ts';
import { USER_AGENT, checkCancelled, requestSignal, errorMessage } from './transport.ts';
import { mapLimit } from './concurrency.ts';

export type ImageSize = '236x' | '474x' | '736x' | 'original';

const MAX_IMAGE_BYTES = 30 * 1024 * 1024;
const MAX_PARALLEL_DOWNLOADS = 6;
const MAX_REDIRECTS = 3;

function parseCdnUrl(input: string): URL {
  if (!isCdnUrl(input)) {
    throw new PinterestError(400, `Only https://…pinimg.com image URLs are supported, got "${input}"`);
  }
  return new URL(input.trim());
}

/**
 * Change an image URL to the requested JPEG size. `original` preserves the URL;
 * resized URLs do not identify the original file extension.
 */
export function sizedUrl(input: string, size: ImageSize): string {
  const url = parseCdnUrl(input);
  if (size === 'original') return url.href;
  const match = /^\/(originals|\d+x(?:\d+)?(?:_RS)?)\/(.+?)(\.\w+)?$/.exec(url.pathname);
  if (!match) return url.href;
  url.pathname = `/${size}/${match[2]}.jpg`;
  return url.href;
}

/** Follow redirects only within Pinterest's CDN. */
async function fetchFromCdn(url: string, options: RequestOptions): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkCancelled(options);
    const response = await fetch(current, {
      headers: { 'User-Agent': USER_AGENT },
      redirect: 'manual',
      signal: requestSignal(options, 30_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    await response.body?.cancel();
    const next = location ? new URL(location, current).href : '';
    if (!isCdnUrl(next)) throw new PinterestError(502, `${url} redirected away from Pinterest's CDN`);
    current = next;
  }
  throw new PinterestError(502, `${url} redirected too many times`);
}

export interface FetchedImage {
  url: string;
  mimeType: string;
  data: Buffer;
}

export async function fetchImage(
  input: string,
  size: ImageSize = 'original',
  options: RequestOptions & { maxBytes?: number } = {},
): Promise<FetchedImage> {
  checkCancelled(options);
  const url = sizedUrl(input, size);
  if (options.maxBytes !== undefined && (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1)) {
    throw new PinterestError(400, 'Image byte limit must be a positive integer.');
  }
  try {
    const response = await fetchFromCdn(url, options);
    const mimeType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!response.ok || !mimeType.startsWith('image/')) {
      await response.body?.cancel();
      if (!response.ok)
        throw new PinterestError(response.status, `Could not download ${url} (HTTP ${response.status})`);
      throw new PinterestError(415, `${url} is not an image (${mimeType || 'unknown type'})`);
    }
    // Enforce the size limit while streaming, independent of Content-Length.
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of response.body ?? []) {
      checkCancelled(options);
      total += chunk.byteLength;
      if (total > Math.min(options.maxBytes ?? MAX_IMAGE_BYTES, MAX_IMAGE_BYTES))
        throw new PinterestError(413, `${url} exceeds the image size limit`);
      chunks.push(chunk);
    }
    return { url, mimeType, data: Buffer.concat(chunks) };
  } catch (cause) {
    checkCancelled(options);
    if (cause instanceof PinterestError) throw cause;
    throw new PinterestError(0, `Could not download ${url}: ${errorMessage(cause)}`);
  }
}

/**
 * Append the size to resized image filenames to prevent collisions with other sizes.
 */
export function fileNameFor(input: string): string {
  const match = /^\/([^/]+)\/(?:.*\/)?([\w.-]+)(\.\w+)$/.exec(parseCdnUrl(input).pathname);
  if (!match) throw new PinterestError(400, `Cannot derive a file name from "${input}"`);
  const [, rendition, name, extension] = match;
  if (!/^[\w.-]+$/.test(rendition!)) throw new PinterestError(400, 'Invalid image size in URL.');
  const file = rendition === 'originals' ? `${name}${extension}` : `${name}_${rendition}${extension}`;
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(file) || /[. ]$/.test(file))
    throw new PinterestError(400, 'Invalid image filename.');
  return file;
}

export interface SavedImage {
  url: string;
  path?: string;
  bytes?: number;
  /** Existing file was preserved. */
  existing?: boolean;
  error?: string;
}

/**
 * Download images into `directory`, creating it if needed. Preserve existing files.
 */
export async function downloadImages(
  urls: string[],
  directory: string,
  options: RequestOptions = {},
): Promise<SavedImage[]> {
  checkCancelled(options);
  if (!directory.trim()) throw new PinterestError(400, 'Download directory must not be blank.');
  const target = path.resolve(directory);
  const unique = [
    ...new Set(
      urls.map((url) => {
        try {
          return parseCdnUrl(url).href;
        } catch {
          return url.trim();
        }
      }),
    ),
  ];
  const results = new Map<string, SavedImage>();
  const claimed = new Map<string, string>();
  const jobs: { url: string; file: string }[] = [];
  for (const url of unique) {
    try {
      const file = path.join(target, fileNameFor(url));
      const owner = claimed.get(file.toLowerCase());
      if (owner) throw new PinterestError(409, `Would be saved under the same file name as ${owner}`);
      claimed.set(file.toLowerCase(), url);
      if (existsSync(file)) results.set(url, { url, path: file, existing: true });
      else jobs.push({ url, file });
    } catch (error) {
      results.set(url, { url, error: (error as Error).message });
    }
  }

  if (jobs.length > 0) await mkdir(target, { recursive: true });
  let completed = unique.length - jobs.length;
  await mapLimit(jobs, MAX_PARALLEL_DOWNLOADS, async (job) => {
    checkCancelled(options);
    try {
      const image = await fetchImage(job.url, 'original', options);
      checkCancelled(options);
      // Link the completed file without overwriting an existing download.
      const temporary = path.join(target, `.pinterest-${randomUUID()}.tmp`);
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(image.data);
        await handle.close();
        checkCancelled(options);
        await link(temporary, job.file);
      } finally {
        await handle.close().catch(() => undefined);
        await unlink(temporary).catch(() => undefined);
      }
      results.set(job.url, { url: job.url, path: job.file, bytes: image.data.length });
    } catch (error) {
      checkCancelled(options);
      const exists = (error as NodeJS.ErrnoException).code === 'EEXIST';
      results.set(
        job.url,
        exists ? { url: job.url, path: job.file, existing: true } : { url: job.url, error: errorMessage(error) },
      );
    }
    await options.onProgress?.(++completed, 'Downloading images', unique.length);
  });
  checkCancelled(options);
  return unique.map((url) => results.get(url)!);
}
