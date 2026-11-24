/** Text formatting for the MCP server and CLI. */

import type { SavedImage } from './images.ts';
import type { Board, Pin, User } from './types.ts';

/** Truncate by code point to preserve surrogate pairs. */
const clip = (value: string, max: number): string => {
  if (value.length <= max) return value;
  const characters = Array.from(value);
  return characters.length > max
    ? `${characters
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`
    : value;
};

const count = (value: number): string => value.toLocaleString('en-US');

export function formatPin(pin: Pin, index?: number, { full = false } = {}): string {
  const max = full ? 2000 : 220;
  const heading = pin.title ?? pin.alt ?? pin.description ?? '(untitled)';
  const lines = [`${index === undefined ? '' : `[${index}] `}${clip(heading, full ? 300 : 120)}`];
  const add = (label: string, value: string | undefined) => {
    if (value) lines.push(`  ${label}: ${value}`);
  };

  if (pin.image) {
    add('image', `${pin.image.url} (${pin.image.width}x${pin.image.height}${pin.color ? `, ${pin.color}` : ''})`);
  }
  add('video', pin.video && `${pin.video.url}${pin.video.durationSeconds ? ` (${pin.video.durationSeconds}s)` : ''}`);
  if (pin.alt && pin.alt !== heading) add('alt', clip(pin.alt, max));
  if (pin.description && pin.description !== heading) add('description', clip(pin.description, max));
  add('tags', pin.tags?.slice(0, full ? 20 : 6).join(', '));
  add(pin.url ? 'pin' : 'id', pin.url ?? pin.id);
  add('source', pin.link);
  add('board', pin.board && `${pin.board.name} - ${pin.board.url}`);
  add(
    'by',
    [
      pin.pinner && `@${pin.pinner.username}${pin.pinner.name ? ` (${pin.pinner.name})` : ''}`,
      pin.saves ? `${count(pin.saves)} ${pin.saves === 1 ? 'save' : 'saves'}` : undefined,
      pin.created,
    ]
      .filter(Boolean)
      .join(', ') || undefined,
  );
  for (const warning of pin.warnings ?? []) add('warning', warning);
  return lines.join('\n');
}

export function formatBoard(board: Board, index?: number): string {
  const stats = [
    board.pins !== undefined ? `${count(board.pins)} pins` : undefined,
    board.followers ? `${count(board.followers)} followers` : undefined,
    board.owner && `by @${board.owner.username}`,
  ].filter(Boolean);
  const lines = [
    `${index === undefined ? '' : `[${index}] `}${board.name}${stats.length ? ` (${stats.join(', ')})` : ''}`,
  ];
  lines.push(`  board: ${board.url}`);
  if (board.description) lines.push(`  description: ${clip(board.description, 220)}`);
  if (board.cover) lines.push(`  cover: ${board.cover}`);
  return lines.join('\n');
}

export function formatSaved(image: SavedImage): string {
  if (image.error) return `FAILED ${image.url}: ${image.error}`;
  return image.existing ? `exists ${image.path} (kept)` : `saved ${image.path}`;
}

export function formatUser(user: User): string {
  const stats = [
    user.followers !== undefined ? `${count(user.followers)} followers` : undefined,
    user.pins !== undefined ? `${count(user.pins)} pins` : undefined,
    user.boards !== undefined ? `${count(user.boards)} boards` : undefined,
  ].filter(Boolean);
  const lines = [
    `@${user.username}${user.name ? ` - ${user.name}` : ''}${stats.length ? ` (${stats.join(', ')})` : ''}`,
  ];
  lines.push(`  profile: ${user.url}`);
  if (user.about) lines.push(`  about: ${clip(user.about, 400)}`);
  if (user.website) lines.push(`  website: ${user.website}`);
  if (user.avatar) lines.push(`  avatar: ${user.avatar}`);
  return lines.join('\n');
}
