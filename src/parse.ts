import { PinterestError } from './types.ts';

export const isNumericId = (id: string): boolean => /^\d+$/.test(id);

/** Extract the 32-character image hash from a Pinterest URL. */
export const signatureOf = (imageUrl: string | undefined): string | undefined =>
  /\/([0-9a-f]{32})\./.exec(imageUrl ?? '')?.[1];

const PINTEREST_HOST = /^(?:[a-z0-9-]+\.)?pinterest\.(?:com|[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/i;

/** True for https URLs on Pinterest's image/video CDN. */
export function isCdnUrl(input: string): boolean {
  try {
    const url = new URL(input.trim());
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      /(^|\.)pinimg\.com$/i.test(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Splits a Pinterest URL (with or without scheme) or a bare path into decoded
 * path segments. `kind` names what the caller expected, for the error message.
 */
function pathSegments(input: string, kind: string): string[] {
  let value = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) {
    throw new PinterestError(400, `Expected an HTTP or HTTPS Pinterest URL: "${input}"`);
  }
  if (value.startsWith('//')) value = `https:${value}`;
  if (/^(?:[a-z0-9-]+\.)?pinterest\.[a-z.]+\//i.test(value)) value = `https://${value}`;
  let path = value.split(/[?#]/)[0]!;
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new PinterestError(400, `Not a ${kind}: "${input}"`);
    }
    if (!PINTEREST_HOST.test(url.hostname)) throw new PinterestError(400, `Not a Pinterest URL: "${input}"`);
    path = url.pathname;
  }
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

/** Accepts a pin ID or any pinterest.com pin URL. */
export function parsePinId(input: string): string {
  const value = input.trim();
  if (/^(\d+|e1_[\w-]+)$/.test(value)) return value;
  const [first, second] = pathSegments(value, 'Pinterest pin URL');
  // Pin pages are /pin/<id>/ or /pin/<seo-slug>--<id>/.
  const id = first === 'pin' && second ? /^(?:.*--)?(\d+|e1_[\w-]+)$/.exec(second)?.[1] : undefined;
  if (!id) throw new PinterestError(400, `Not a Pinterest pin ID or pin URL: "${input}"`);
  return id;
}

/** Accepts a board URL, `/user/board/` or `user/board`. Returns `/user/board/`, percent-encoded. */
export function parseBoardPath(input: string): string {
  const [username, slug] = pathSegments(input, 'Pinterest board URL');
  if (
    !username ||
    !slug ||
    slug === '.' ||
    slug === '..' ||
    /[.\s/]/.test(username) ||
    ['pin', 'search', 'ideas', 'topics'].includes(username.toLowerCase()) ||
    ['_saved', '_created'].includes(slug.toLowerCase())
  ) {
    throw new PinterestError(400, `Not a Pinterest board (expected "username/board-name" or a board URL): "${input}"`);
  }
  return `/${encodeURIComponent(username)}/${encodeURIComponent(slug)}/`;
}

/** Accepts a username, `@username` or a profile URL. */
export function parseUsername(input: string): string {
  const value = input.trim().replace(/^@/, '');
  const segments = pathSegments(value, 'Pinterest profile URL');
  const isUrl = /^(https?:\/\/|\/\/|(?:[a-z0-9-]+\.)?pinterest\.[a-z.]+\/)/i.test(value);
  const username = segments[0];
  if (
    !username ||
    /[\s/]/.test(username) ||
    username === '.' ||
    username === '..' ||
    ['pin', 'search', 'ideas', 'topics'].includes(username.toLowerCase()) ||
    (!isUrl && segments.length > 1)
  ) {
    throw new PinterestError(400, `Not a Pinterest username or profile URL: "${input}"`);
  }
  return username;
}

export function queryText(input: string): string {
  if (!input.trim()) throw new PinterestError(400, 'Search query must not be blank.');
  return input.trim();
}
