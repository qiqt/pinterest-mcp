import { fetchImage, type ImageSize } from './images.ts';
import { mapLimit } from './concurrency.ts';
import { checkCancelled, errorMessage } from './transport.ts';
import { PinterestError, type RequestOptions } from './types.ts';
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js';

export const text = (value: string): ContentBlock => ({ type: 'text', text: value });
const MAX_PREVIEW_BYTES = 1024 * 1024;
const MAX_BASE64_BYTES = 6 * 1024 * 1024;
type Preview = { url: string; shown: boolean; mimeType?: string; error?: string };

export async function imageBlocks(urls: string[], size: ImageSize, options: RequestOptions) {
  let used = 0;
  let exhausted = false;
  const blocks: ContentBlock[][] = [];
  const images: Preview[] = [];
  const warnings: string[] = [];
  const omit = (url: string, error: string) => {
    images.push({ url, shown: false, error });
    blocks.push([]);
    warnings.push(`${url}: ${error}`);
  };
  for (let offset = 0; offset < urls.length; ) {
    checkCancelled(options);
    const remaining = MAX_BASE64_BYTES - used;
    if (exhausted || remaining < 4) {
      for (const url of urls.slice(offset)) omit(url, 'Preview omitted to keep the response within the size limit.');
      break;
    }
    // Only buffer one batch; reserve enough room before starting its downloads.
    const maxBytes = Math.min(MAX_PREVIEW_BYTES, Math.floor(remaining / 4) * 3);
    const batchSize = Math.max(1, Math.min(4, Math.floor(remaining / (4 * Math.ceil(maxBytes / 3)))));
    const batch = urls.slice(offset, offset + batchSize);
    const fetched = await mapLimit(batch, 4, async (url) => {
      try {
        return await fetchImage(url, size, { ...options, maxBytes });
      } catch (error) {
        checkCancelled(options);
        return error instanceof Error ? error : new Error(errorMessage(error));
      }
    });
    fetched.forEach((image, index) => {
      const url = batch[index]!;
      if (image instanceof Error) {
        if (maxBytes < MAX_PREVIEW_BYTES && image instanceof PinterestError && image.status === 413) exhausted = true;
        omit(url, image.message);
        return;
      }
      const data = image.data.toString('base64');
      used += data.length;
      blocks.push([text(url), { type: 'image', data, mimeType: image.mimeType }]);
      images.push({ url, shown: true, mimeType: image.mimeType });
    });
    offset += batch.length;
  }
  return { content: blocks.flat(), blocks, images, warnings };
}
