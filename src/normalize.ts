import { PinterestError, type Pin, type Board, type User, type Raw } from './types.ts';
import { isNumericId } from './parse.ts';
import { WEB, record } from './transport.ts';

const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed || undefined;
};

const absolute = (path: string): string => (path.startsWith('http') ? path : WEB + path);
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const idOf = (raw: Raw): string => {
  if ((typeof raw.id !== 'string' && typeof raw.id !== 'number') || !/^(\d+|e1_[\w-]+)$/.test(String(raw.id)))
    throw new PinterestError(502, 'Invalid pin or board ID in Pinterest response.');
  return String(raw.id);
};

function pickVideo(raw: Raw): Pin['video'] {
  const list: Raw | undefined =
    raw.videos?.video_list ??
    (Array.isArray(raw.story_pin_data?.pages?.[0]?.blocks)
      ? raw.story_pin_data.pages[0].blocks.find((block: Raw) => block?.video)?.video?.video_list
      : undefined);
  if (!list) return undefined;
  const renditions = Object.values(list).filter((rendition: any) => typeof rendition?.url === 'string') as Raw[];
  if (renditions.length === 0) return undefined;
  // Prefer a directly playable MP4, then the widest rendition.
  const isMp4 = (rendition: Raw) => (rendition.url.includes('.mp4') ? 1 : 0);
  renditions.sort((a, b) => isMp4(b) - isMp4(a) || (b.width ?? 0) - (a.width ?? 0));
  const best = renditions[0]!;
  const duration = number(best.duration);
  return { url: best.url, durationSeconds: duration ? Math.round(duration / 100) / 10 : undefined };
}

export function toPin(raw: Raw): Pin {
  record(raw, 'pin');
  const id = idOf(raw);
  const original = raw.images?.orig;
  const created = raw.created_at ? new Date(raw.created_at) : undefined;
  const domain = text(raw.domain);
  const pin: Pin = {
    id,
    url: isNumericId(id) ? `${WEB}/pin/${id}/` : undefined,
    title: text(raw.title) ?? text(raw.grid_title),
    description: text(raw.description),
    alt: text(raw.alt_text) ?? text(raw.auto_alt_text) ?? text(raw.seo_alt_text),
    image: text(original?.url)
      ? { url: original.url, width: number(original.width) ?? 0, height: number(original.height) ?? 0 }
      : undefined,
    thumbnail: text(raw.images?.['236x']?.url),
    color: text(raw.dominant_color),
    tags: Array.isArray(raw.pin_join?.visual_annotation)
      ? raw.pin_join.visual_annotation.filter((tag: unknown) => typeof tag === 'string')
      : undefined,
    link: text(raw.link),
    domain: domain && domain !== 'Uploaded by user' ? domain : undefined,
    board: text(raw.board?.url)
      ? { name: text(raw.board.name) ?? 'Untitled board', url: absolute(raw.board.url) }
      : undefined,
    pinner: text(raw.pinner?.username)
      ? { username: raw.pinner.username, name: text(raw.pinner.full_name) }
      : undefined,
    video: pickVideo(raw),
    saves: number(raw.aggregated_pin_data?.aggregated_stats?.saves) ?? number(raw.repin_count),
    created: created && !Number.isNaN(created.getTime()) ? created.toISOString().slice(0, 10) : undefined,
  };
  return pin;
}

export function toBoard(raw: Raw): Board {
  record(raw, 'board');
  if (!text(raw.url)) throw new PinterestError(502, 'Missing board URL in Pinterest response.');
  return {
    id: idOf(raw),
    name: text(raw.name) ?? 'Untitled board',
    url: absolute(raw.url),
    description: text(raw.description),
    pins: number(raw.pin_count),
    followers: number(raw.follower_count),
    owner: text(raw.owner?.username) ? { username: raw.owner.username, name: text(raw.owner.full_name) } : undefined,
    cover: text(raw.image_cover_hd_url) ?? text(raw.image_cover_url),
  };
}

export function toUser(raw: Raw): User {
  record(raw, 'user');
  if (!text(raw.username)) throw new PinterestError(502, 'Missing username in Pinterest response.');
  return {
    username: raw.username,
    url: `${WEB}/${raw.username}/`,
    name: text(raw.full_name),
    about: text(raw.about),
    website: text(raw.website_url),
    avatar: text(raw.image_xlarge_url) ?? text(raw.image_medium_url),
    followers: number(raw.follower_count),
    pins: number(raw.pin_count),
    boards: number(raw.board_count),
  };
}
