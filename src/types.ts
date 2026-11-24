export interface Pin {
  /** Numeric pin ID, or an obfuscated `e1_…` ID (see `resolvePinId`). */
  id: string;
  /** Pin page URL. Absent when the numeric ID is unavailable. */
  url?: string;
  title?: string;
  description?: string;
  alt?: string;
  /** Largest available image. */
  image?: { url: string; width: number; height: number };
  /** 236px-wide JPEG. */
  thumbnail?: string;
  /** Dominant colour as `#rrggbb`. */
  color?: string;
  /** Pinterest's image tags. */
  tags?: string[];
  /** External page the pin links to. */
  link?: string;
  domain?: string;
  board?: { name: string; url: string };
  pinner?: { username: string; name?: string };
  /** HLS stream (.m3u8) in listings; `getPin` returns a direct MP4 when available. */
  video?: { url: string; durationSeconds?: number };
  saves?: number;
  /** `YYYY-MM-DD`. */
  created?: string;
  warnings?: string[];
}

export interface Board {
  id: string;
  name: string;
  url: string;
  description?: string;
  pins?: number;
  followers?: number;
  owner?: { username: string; name?: string };
  cover?: string;
}

export interface User {
  username: string;
  url: string;
  name?: string;
  about?: string;
  website?: string;
  avatar?: string;
  followers?: number;
  pins?: number;
  boards?: number;
}

/** Opaque continuation token. Pass it back to the call that produced it. */
export interface Cursor<T> {
  bookmark?: string;
  buffer: T[];
  /** Which backend produced this cursor, where a call can use more than one. */
  via?: string;
}

export interface Page<T> {
  items: T[];
  /** Present when more results exist. */
  next?: Cursor<T>;
}

export interface RequestOptions {
  signal?: AbortSignal;
  onProgress?: (completed: number, message: string, total?: number) => void | Promise<void>;
}

export interface PageOptions<T> extends RequestOptions {
  /** Maximum number of items to return. Default 25. */
  limit?: number;
  cursor?: Cursor<T>;
}

export class PinterestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'PinterestError';
    this.status = status;
  }
}

export type Raw = Record<string, any>;
