import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { createClient } from './pinterest.ts';
import { downloadImages } from './images.ts';
import { formatBoard, formatPin, formatSaved, formatUser } from './format.ts';
import { imageBlocks, text } from './mcp-output.ts';
import { checkCancelled, errorMessage } from './transport.ts';
import type { Pin, Board, Page, Cursor, PageOptions, RequestOptions } from './types.ts';

const optionalText = z.string().optional();
const optionalNumber = z.number().optional();
const person = z.object({ username: z.string(), name: optionalText });
const pinSchema = z.object({
  id: z.string(),
  url: optionalText,
  title: optionalText,
  description: optionalText,
  alt: optionalText,
  image: z.object({ url: z.string(), width: z.number(), height: z.number() }).optional(),
  thumbnail: optionalText,
  color: optionalText,
  tags: z.array(z.string()).optional(),
  link: optionalText,
  domain: optionalText,
  board: z.object({ name: z.string(), url: z.string() }).optional(),
  pinner: person.optional(),
  video: z.object({ url: z.string(), durationSeconds: optionalNumber }).optional(),
  saves: optionalNumber,
  created: optionalText,
  warnings: z.array(z.string()).optional(),
});
const boardSchema = z.object({
  id: z.string(),
  name: z.string(),
  url: z.string(),
  description: optionalText,
  pins: optionalNumber,
  followers: optionalNumber,
  owner: person.optional(),
  cover: optionalText,
});
const userSchema = z.object({
  username: z.string(),
  url: z.string(),
  name: optionalText,
  about: optionalText,
  website: optionalText,
  avatar: optionalText,
  followers: optionalNumber,
  pins: optionalNumber,
  boards: optionalNumber,
});
const warningsSchema = z.array(z.string());
const imagesSchema = z.array(
  z.object({ url: z.string(), shown: z.boolean(), mimeType: optionalText, error: optionalText }),
);
const listingSchema = {
  kind: z.enum(['pins', 'boards']),
  items: z.array(z.union([pinSchema, boardSchema])),
  nextCursor: optionalText,
  warnings: warningsSchema,
};
const limit = (fallback: number) => z.number().int().min(1).max(100).default(fallback);
const preview = z.boolean().default(true).describe('Include up to 30 thumbnails, within the response size limit.');
const query = z.string().trim().min(1).describe('Search keywords.');
const ref = z.string().trim().min(1);
const readOnly = { readOnlyHint: true, openWorldHint: true };
type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Result = { content: CallToolResult['content']; structuredContent: Record<string, unknown>; isError?: boolean };
type Loader = (limit: number, preview: boolean, options: RequestOptions) => Promise<Result>;

export function createServer(client = createClient()): McpServer {
  const server = new McpServer(
    { name: 'pinterest', version: pkg.version },
    {
      instructions:
        'Search with search_pins, inspect with view_images, and save with download_images. ' +
        'Results include structured data, text and optional thumbnails. Hidden e1_ IDs and cursors belong to this session.',
    },
  );
  const continuations = new Map<string, Loader>();
  let continuationCount = 0;
  function remember(loader: Loader): string {
    const handle = `c${++continuationCount}`;
    if (continuations.size >= 100) continuations.delete(continuations.keys().next().value!);
    continuations.set(handle, loader);
    return handle;
  }
  async function run(extra: Extra, produce: (options: RequestOptions) => Promise<Result>): Promise<CallToolResult> {
    let progress = 0;
    const options: RequestOptions = {
      signal: extra.signal,
      onProgress: async (completed, message, total) => {
        if (extra._meta?.progressToken !== undefined) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: {
              progressToken: extra._meta.progressToken,
              progress: ++progress,
              message: `${message}: ${completed}${total === undefined ? '' : `/${total}`}`,
            },
          });
        }
      },
    };
    try {
      checkCancelled(options);
      const result = await produce(options);
      checkCancelled(options);
      if (Buffer.byteLength(JSON.stringify(result)) > 8 * 1024 * 1024)
        throw new Error('Response is too large. Request fewer results or disable previews.');
      return result;
    } catch (error) {
      checkCancelled(options);
      return { content: [text(`Error: ${errorMessage(error).slice(0, 2000)}`)], isError: true };
    }
  }
  function loader<T extends Pin | Board>(
    kind: 'pins' | 'boards',
    load: (options: PageOptions<T>) => Promise<Page<T>>,
    cursor?: Cursor<T>,
    start = 1,
  ): Loader {
    return async (limit, preview, options) => {
      const page = await load({ ...options, limit, cursor });
      const content: CallToolResult['content'] = [];
      const pinWarnings = page.items.flatMap((item) => (item as Pin).warnings ?? []);
      const previewWarnings: string[] = [];
      const thumbnails = new Map<number, CallToolResult['content']>();
      if (preview && kind === 'pins') {
        const selected = (page.items as Pin[])
          .slice(0, 30)
          .flatMap((pin, index) => (pin.thumbnail ? [{ url: pin.thumbnail, index }] : []));
        const images = await imageBlocks(
          selected.map((item) => item.url),
          'original',
          options,
        );
        selected.forEach((item, index) =>
          thumbnails.set(
            item.index,
            images.blocks[index]!.filter((block) => block.type === 'image'),
          ),
        );
        previewWarnings.push(...images.warnings);
        if (page.items.length > 30) previewWarnings.push('Thumbnails are limited to the first 30 pins.');
      }
      page.items.forEach((item, index) => {
        content.push(
          text(kind === 'pins' ? formatPin(item as Pin, start + index) : formatBoard(item as Board, start + index)),
        );
        content.push(...(thumbnails.get(index) ?? []));
      });
      const warnings = [...pinWarnings, ...previewWarnings];
      const nextCursor = page.next && remember(loader(kind, load, page.next, start + page.items.length));
      content.push(
        text(
          nextCursor
            ? `More results are available: call more_results with cursor "${nextCursor}".`
            : page.items.length
              ? 'End of results.'
              : 'No results.',
        ),
      );
      content.push(...previewWarnings.map((warning) => text(`Warning: ${warning}`)));
      return { content, structuredContent: { kind, items: page.items, ...(nextCursor && { nextCursor }), warnings } };
    };
  }
  server.registerTool(
    'search_pins',
    {
      title: 'Search Pinterest pins',
      description: 'Find pins by keyword, with image URLs and available metadata.',
      inputSchema: { query, limit: limit(15), preview },
      outputSchema: listingSchema,
      annotations: readOnly,
    },
    ({ query, limit, preview }, extra) =>
      run(extra, (options) => loader<Pin>('pins', (opts) => client.searchPins(query, opts))(limit, preview, options)),
  );
  server.registerTool(
    'search_boards',
    {
      title: 'Search Pinterest boards',
      description: 'Find boards by keyword. Use board_pins to list their pins.',
      inputSchema: { query, limit: limit(10) },
      outputSchema: listingSchema,
      annotations: readOnly,
    },
    ({ query, limit }, extra) =>
      run(extra, (options) =>
        loader<Board>('boards', (opts) => client.searchBoards(query, opts))(limit, false, options),
      ),
  );
  server.registerTool(
    'suggest_queries',
    {
      title: 'Suggest search queries',
      description: 'Get Pinterest search suggestions for a term.',
      inputSchema: { term: query },
      outputSchema: { suggestions: z.array(z.string()) },
      annotations: readOnly,
    },
    ({ term }, extra) =>
      run(extra, async (options) => {
        const suggestions = await client.suggestQueries(term, options);
        return { content: [text(suggestions.join('\n') || 'No suggestions.')], structuredContent: { suggestions } };
      }),
  );
  server.registerTool(
    'get_pin',
    {
      title: 'Get pin details',
      description: 'Get pin details and an MP4 when available. A warning marks cached results.',
      inputSchema: {
        pin: ref.describe('Pin URL, numeric ID, or an e1_ ID from this session.'),
        find_url: z
          .boolean()
          .default(false)
          .describe('Also search the owner’s 1,000 most recent saves for the pin page.'),
        preview: preview.describe('Include one preview up to 736px wide, within the response size limit.'),
      },
      outputSchema: { pin: pinSchema, images: imagesSchema, warnings: warningsSchema },
      annotations: readOnly,
    },
    ({ pin, find_url, preview }, extra) =>
      run(extra, async (options) => {
        const details = await client.getPin(pin, { ...options, deep: find_url });
        const images = await imageBlocks(preview && details.image ? [details.image.url] : [], '736x', options);
        const warnings = [...(details.warnings ?? []), ...images.warnings];
        return {
          content: [
            text(formatPin(details, undefined, { full: true })),
            ...images.content,
            ...images.warnings.map(text),
          ],
          structuredContent: { pin: details, images: images.images, warnings },
        };
      }),
  );
  server.registerTool(
    'related_pins',
    {
      title: 'Find similar pins',
      description: 'Find similar pins using a pin ID, pin URL or Pinterest image URL.',
      inputSchema: {
        pin: ref.describe('Pin URL, numeric ID, session e1_ ID, or pinimg.com image URL.'),
        limit: limit(15),
        preview,
      },
      outputSchema: listingSchema,
      annotations: readOnly,
    },
    ({ pin, limit, preview }, extra) =>
      run(extra, (options) => loader<Pin>('pins', (opts) => client.relatedPins(pin, opts))(limit, preview, options)),
  );
  server.registerTool(
    'board_pins',
    {
      title: 'List a board’s pins',
      description: 'Board details followed by its pins, in board order.',
      inputSchema: { board: ref.describe('Board URL or username/board-slug.'), limit: limit(15), preview },
      outputSchema: { ...listingSchema, board: boardSchema },
      annotations: readOnly,
    },
    ({ board, limit, preview }, extra) =>
      run(extra, async (options) => {
        let info: Board | undefined;
        const result = await loader<Pin>('pins', async (opts) => {
          const page = await client.boardPins(board, opts);
          info = page.board;
          return page;
        })(limit, preview, options);
        return {
          content: [text(formatBoard(info!)), ...result.content],
          structuredContent: { ...result.structuredContent, board: info },
        };
      }),
  );
  server.registerTool(
    'user_profile',
    {
      title: 'Get a user profile',
      description: 'A Pinterest profile and its public boards.',
      inputSchema: { user: ref.describe('Username, @username or profile URL.'), limit: limit(25) },
      outputSchema: { ...listingSchema, user: userSchema },
      annotations: readOnly,
    },
    ({ user, limit }, extra) =>
      run(extra, async (options) => {
        const profile = await client.getUser(user, options);
        const result = await loader<Board>('boards', (opts) => client.userBoards(user, opts))(limit, false, options);
        return {
          content: [text(formatUser(profile)), ...result.content],
          structuredContent: { ...result.structuredContent, user: profile },
        };
      }),
  );
  server.registerTool(
    'user_pins',
    {
      title: 'List a user’s pins',
      description: 'A user’s pins, newest first.',
      inputSchema: { user: ref, limit: limit(15), preview },
      outputSchema: listingSchema,
      annotations: readOnly,
    },
    ({ user, limit, preview }, extra) =>
      run(extra, (options) => loader<Pin>('pins', (opts) => client.userPins(user, opts))(limit, preview, options)),
  );
  server.registerTool(
    'more_results',
    {
      title: 'Load more results',
      description: 'Load the next page using a cursor from this session.',
      inputSchema: { cursor: ref, limit: limit(15), preview },
      outputSchema: listingSchema,
      annotations: readOnly,
    },
    ({ cursor, limit, preview }, extra) =>
      run(extra, (options) => {
        const load = continuations.get(cursor);
        if (!load) throw new Error(`Unknown or expired cursor "${cursor}". Run the original search again.`);
        return load(limit, preview, options);
      }),
  );
  server.registerTool(
    'view_images',
    {
      title: 'View images',
      description: 'View up to 8 Pinterest images within the response size limit.',
      inputSchema: { urls: z.array(ref).min(1).max(8), size: z.enum(['236x', '474x', '736x']).default('736x') },
      outputSchema: { images: imagesSchema, warnings: warningsSchema },
      annotations: readOnly,
    },
    ({ urls, size }, extra) =>
      run(extra, async (options) => {
        const images = await imageBlocks(urls, size, options);
        return {
          content: [...images.content, ...images.warnings.map(text)],
          structuredContent: { images: images.images, warnings: images.warnings },
          isError: !images.images.some((image) => image.shown),
        };
      }),
  );
  server.registerTool(
    'download_images',
    {
      title: 'Download images',
      description: 'Save Pinterest images and return file paths. Existing files are kept.',
      inputSchema: {
        urls: z.array(ref).min(1).max(50),
        directory: ref
          .optional()
          .describe('Target directory. Default: PINTEREST_DOWNLOAD_DIR or ./pinterest-downloads.'),
      },
      outputSchema: {
        saved: z.array(
          z.object({
            url: z.string(),
            path: optionalText,
            bytes: optionalNumber,
            existing: z.boolean().optional(),
            error: optionalText,
          }),
        ),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ urls, directory }, extra) =>
      run(extra, async (options) => {
        const saved = await downloadImages(
          urls,
          directory ?? (process.env.PINTEREST_DOWNLOAD_DIR?.trim() || 'pinterest-downloads'),
          options,
        );
        return {
          content: [text(saved.map(formatSaved).join('\n'))],
          structuredContent: { saved },
          isError: saved.every((image) => image.error),
        };
      }),
  );
  return server;
}
