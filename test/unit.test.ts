/** Offline tests for input parsing, normalization and formatting. */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatPin } from '../src/format.ts';
import { downloadImages, fileNameFor, sizedUrl } from '../src/images.ts';
import { parseBoardPath, parsePinId, parseUsername, PinterestError, toPin } from '../src/pinterest.ts';

test('parsePinId accepts IDs and pin URLs', () => {
  assert.equal(parsePinId('134263632640461792'), '134263632640461792');
  assert.equal(parsePinId(' https://www.pinterest.com/pin/134263632640461792/ '), '134263632640461792');
  assert.equal(
    parsePinId('https://pinterest.co.uk/pin/some-seo-title--134263632640461792/?utm=1'),
    '134263632640461792',
  );
  assert.equal(parsePinId('e1_AfqPShy-U4G9_TZD'), 'e1_AfqPShy-U4G9_TZD');
  assert.equal(parsePinId('https://www.pinterest.com/pin/e1_AfqPShy-U4G9_TZD/'), 'e1_AfqPShy-U4G9_TZD');
  assert.throws(() => parsePinId('https://www.pinterest.com/someone/board/'), PinterestError);
  assert.throws(() => parsePinId('not a pin'), PinterestError);
  // A slug that merely starts with digits is not an ID.
  assert.throws(() => parsePinId('https://www.pinterest.com/pin/2025-retro-poster/'), PinterestError);
  assert.throws(() => parsePinId('https://www.pinterest.com/pin/12345abc/'), PinterestError);
  // Extract IDs from Pinterest URL paths.
  assert.equal(parsePinId('/pin/123/'), '123');
  assert.equal(parsePinId('www.pinterest.com/pin/123'), '123');
  assert.throws(() => parsePinId('https://example.org/?next=/pin/123/'), PinterestError);
  assert.throws(() => parsePinId('https://www.pinterest.com/search/pins/?q=/pin/123/'), PinterestError);
});

test('parseBoardPath normalizes URLs, paths and unicode slugs', () => {
  assert.equal(parseBoardPath('archeyesnews/brutalist-architecture'), '/archeyesnews/brutalist-architecture/');
  assert.equal(parseBoardPath('/archeyesnews/brutalist-architecture/'), '/archeyesnews/brutalist-architecture/');
  assert.equal(
    parseBoardPath('https://www.pinterest.com/archeyesnews/brutalist-architecture/?x=1#top'),
    '/archeyesnews/brutalist-architecture/',
  );
  // Raw and pre-encoded unicode converge on a single encoding.
  assert.equal(parseBoardPath('user/königsberg'), '/user/k%C3%B6nigsberg/');
  assert.equal(parseBoardPath('https://www.pinterest.com/user/k%C3%B6nigsberg/'), '/user/k%C3%B6nigsberg/');
  assert.throws(() => parseBoardPath('justoneword'), PinterestError);
  assert.throws(() => parseBoardPath('https://www.pinterest.com/pin/123/'), PinterestError);
  assert.throws(() => parseBoardPath('https://example.com/user/board/'), PinterestError);
  // URLs without a scheme, regional domains, and look-alike hosts.
  assert.equal(
    parseBoardPath('www.pinterest.com/archeyesnews/brutalist-architecture'),
    '/archeyesnews/brutalist-architecture/',
  );
  assert.equal(parseBoardPath('https://pinterest.co.uk/user/board/'), '/user/board/');
  assert.throws(() => parseBoardPath('https://pinterest.evil.com/user/board/'), PinterestError);
  assert.throws(() => parseBoardPath('https://'), PinterestError);
  assert.throws(() => parseBoardPath('ftp://example.com/user/board'), PinterestError);
  assert.throws(() => parseBoardPath('PIN/123'), PinterestError);
  assert.throws(() => parseBoardPath('user/_SAVED'), PinterestError);
  for (const slug of ['.', '..', '%2e', '%2e%2e']) assert.throws(() => parseBoardPath(`user/${slug}`), PinterestError);
});

test('parseUsername accepts names, handles and profile URLs', () => {
  assert.equal(parseUsername('archeyesnews'), 'archeyesnews');
  assert.equal(parseUsername('@archeyesnews'), 'archeyesnews');
  assert.equal(parseUsername('https://www.pinterest.com/archeyesnews/_created/'), 'archeyesnews');
  assert.equal(parseUsername('archeyesnews?utm=1'), 'archeyesnews');
  assert.equal(parseUsername('https://www.pinterest.com/k%C3%B6nig/'), 'könig');
  assert.throws(() => parseUsername('a/b'), PinterestError);
  assert.throws(() => parseUsername('a%2Fb'), PinterestError);
  assert.throws(() => parseUsername('  '), PinterestError);
  assert.throws(() => parseUsername('foo bar'), PinterestError);
  assert.throws(() => parseUsername('https://example.com/someuser'), PinterestError);
  assert.throws(() => parseUsername('https://www.pinterest.com/pin/12345/'), PinterestError);
  assert.throws(() => parseUsername('https://'), PinterestError);
  assert.throws(() => parseUsername('PIN'), PinterestError);
  for (const name of ['.', '..', '%2e', '%2e%2e']) assert.throws(() => parseUsername(name), PinterestError);
});

test('fileNameFor keeps renditions of one image apart', () => {
  assert.equal(
    fileNameFor('https://i.pinimg.com/originals/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.png'),
    '0f4bea09f5938f8d8342a0e818e8f4d0.png',
  );
  assert.equal(
    fileNameFor('https://i.pinimg.com/736x/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.jpg'),
    '0f4bea09f5938f8d8342a0e818e8f4d0_736x.jpg',
  );
  assert.throws(() => fileNameFor('https://i.pinimg.com/originals/0f/4b/ea/'), PinterestError);
  assert.throws(() => fileNameFor('https://example.com/originals/a.jpg'), PinterestError);
});

test('downloadImages rejects foreign URLs without touching the disk', async () => {
  const directory = path.join(tmpdir(), `pinterest-unit-${process.pid}-never-created`);
  const saved = await downloadImages(['https://example.com/a.jpg'], directory);
  assert.equal(saved.length, 1);
  assert.match(saved[0]!.error!, /Only https:\/\/…pinimg\.com/);
  assert.equal(existsSync(directory), false);
});

test('sizedUrl switches renditions and rejects non-Pinterest hosts', () => {
  const original = 'https://i.pinimg.com/originals/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.png';
  assert.equal(sizedUrl(original, '474x'), 'https://i.pinimg.com/474x/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.jpg');
  assert.equal(
    sizedUrl('https://i.pinimg.com/236x/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.jpg', '736x'),
    'https://i.pinimg.com/736x/0f/4b/ea/0f4bea09f5938f8d8342a0e818e8f4d0.jpg',
  );
  assert.equal(sizedUrl(original, 'original'), original);
  assert.throws(() => sizedUrl('https://example.com/originals/a.jpg', '474x'), PinterestError);
  assert.throws(() => sizedUrl('https://pinimg.com.evil.test/originals/a.jpg', '474x'), PinterestError);
  assert.throws(() => sizedUrl('http://i.pinimg.com/originals/a.jpg', '474x'), PinterestError);
});

const rawPin = {
  type: 'pin',
  id: '134263632640461792',
  title: '  ',
  grid_title: 'Maurice Ravel Auditorium',
  description: 'Night view\n of the   hall ',
  auto_alt_text: 'a concert hall at night',
  dominant_color: '#3e3c3b',
  domain: 'Uploaded by user',
  link: 'https://archeyes.com/article/',
  created_at: 'Thu, 13 Nov 2025 18:05:51 +0000',
  image_signature: 'e31585a92197413c0868cabb1c3e46e0',
  images: {
    '236x': { width: 236, height: 157, url: 'https://i.pinimg.com/236x/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg' },
    orig: {
      width: 850,
      height: 567,
      url: 'https://i.pinimg.com/originals/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg',
    },
  },
  pin_join: { visual_annotation: ['Night Architecture', 'Concert Hall'] },
  board: { name: 'Brutalist Architecture', url: '/archeyesnews/brutalist-architecture/' },
  pinner: { username: 'archeyesnews', full_name: 'ArchEyes' },
  aggregated_pin_data: { aggregated_stats: { saves: 1200 } },
  videos: {
    video_list: {
      V_HLSV4: { url: 'https://v1.pinimg.com/videos/a.m3u8', width: 720, duration: 19900 },
      V_720P: { url: 'https://v1.pinimg.com/videos/a.mp4', width: 480, duration: 19900 },
    },
  },
};

test('toPin normalizes metadata and prefers MP4 video', () => {
  assert.deepEqual(toPin(rawPin), {
    id: '134263632640461792',
    url: 'https://www.pinterest.com/pin/134263632640461792/',
    title: 'Maurice Ravel Auditorium',
    description: 'Night view of the hall',
    alt: 'a concert hall at night',
    image: {
      url: 'https://i.pinimg.com/originals/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg',
      width: 850,
      height: 567,
    },
    thumbnail: 'https://i.pinimg.com/236x/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg',
    color: '#3e3c3b',
    tags: ['Night Architecture', 'Concert Hall'],
    link: 'https://archeyes.com/article/',
    domain: undefined,
    board: { name: 'Brutalist Architecture', url: 'https://www.pinterest.com/archeyesnews/brutalist-architecture/' },
    pinner: { username: 'archeyesnews', name: 'ArchEyes' },
    video: { url: 'https://v1.pinimg.com/videos/a.mp4', durationSeconds: 19.9 },
    saves: 1200,
    created: '2025-11-13',
  });
});

test('toPin gives obfuscated pins no pin URL', () => {
  const pin = toPin({ ...rawPin, id: 'e1_AfqPShyU4G9', videos: null });
  assert.equal(pin.id, 'e1_AfqPShyU4G9');
  assert.equal(pin.url, undefined);
  assert.equal(pin.video, undefined);
});

test('formatPin never cuts an emoji in half', () => {
  const heading = formatPin({ id: '1', title: `${'a'.repeat(118)}🔥🎉🎉` }).split('\n')[0]!;
  assert.equal(heading, `${'a'.repeat(118)}🔥…`);
  assert.equal(heading.isWellFormed(), true);
});

test('formatPin renders a compact, numbered entry', () => {
  assert.equal(
    formatPin(toPin({ ...rawPin, videos: null }), 3),
    [
      '[3] Maurice Ravel Auditorium',
      '  image: https://i.pinimg.com/originals/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg (850x567, #3e3c3b)',
      '  alt: a concert hall at night',
      '  description: Night view of the hall',
      '  tags: Night Architecture, Concert Hall',
      '  pin: https://www.pinterest.com/pin/134263632640461792/',
      '  source: https://archeyes.com/article/',
      '  board: Brutalist Architecture - https://www.pinterest.com/archeyesnews/brutalist-architecture/',
      '  by: @archeyesnews (ArchEyes), 1,200 saves, 2025-11-13',
    ].join('\n'),
  );
});
