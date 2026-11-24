#!/usr/bin/env node
/** Command-line front end. Run `pinterest help` for usage. */

import { parseArgs } from 'node:util';
import { formatBoard, formatPin, formatSaved, formatUser } from './format.ts';
import { downloadImages } from './images.ts';
import {
  boardPins,
  getPin,
  getUser,
  relatedPins,
  searchBoards,
  searchPins,
  suggestQueries,
  userBoards,
  userPins,
} from './pinterest.ts';

const USAGE = `Login-free Pinterest search.

Usage: pinterest <command> [arguments] [--limit N] [--json]

  search <query>             Search pins
  boards <query>             Search boards
  suggest <term>             Autocomplete search queries
  pin <id|url>               Details of one pin
  related <id|url|image-url>  Find similar pins
  board <url|user/board>      A board and its pins
  user <username|url>        A profile and its boards
  user-pins <username>       A user's pins, newest first
  download <image-url...>    Save images (--dir, default ./pinterest-downloads)

Options:
  --limit N   Maximum results (default 20)
  --json      Print JSON instead of text
  --dir PATH  Download directory
`;

const COMMANDS = ['search', 'boards', 'suggest', 'pin', 'related', 'board', 'user', 'user-pins', 'download'];

const list = <T>(items: T[], format: (item: T, index: number) => string): string =>
  items.length ? items.map((item, index) => format(item, index + 1)).join('\n\n') : 'No results.';

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      limit: { type: 'string', default: '20' },
      json: { type: 'boolean', default: false },
      dir: { type: 'string', default: process.env.PINTEREST_DOWNLOAD_DIR?.trim() || 'pinterest-downloads' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, ...rest] = positionals;
  const argument = rest.join(' ');

  if (values.help || !command || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (!COMMANDS.includes(command)) throw new Error(`Unknown command "${command}". Run "pinterest help".`);
  if (!argument.trim()) throw new Error(`"${command}" needs an argument. Run "pinterest help".`);
  if (!/^[1-9]\d*$/.test(values.limit)) throw new Error('--limit must be a positive integer.');
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit > 100) throw new Error('--limit must be an integer from 1 to 100.');

  const print = (data: unknown, render: () => string): void => {
    console.log(values.json ? JSON.stringify(data, null, 2) : render());
  };

  switch (command) {
    case 'search': {
      const { items } = await searchPins(argument, { limit });
      return print(items, () => list(items, formatPin));
    }
    case 'boards': {
      const { items } = await searchBoards(argument, { limit });
      return print(items, () => list(items, formatBoard));
    }
    case 'suggest': {
      const queries = await suggestQueries(argument);
      return print(queries, () => queries.join('\n') || 'No suggestions.');
    }
    case 'pin': {
      const pin = await getPin(argument);
      return print(pin, () => formatPin(pin, undefined, { full: true }));
    }
    case 'related': {
      const { items } = await relatedPins(argument, { limit });
      return print(items, () => list(items, formatPin));
    }
    case 'board': {
      const { board, items } = await boardPins(argument, { limit });
      return print({ board, pins: items }, () => `${formatBoard(board)}\n\n${list(items, formatPin)}`);
    }
    case 'user': {
      const [user, { items }] = await Promise.all([getUser(argument), userBoards(argument, { limit })]);
      return print({ user, boards: items }, () => `${formatUser(user)}\n\n${list(items, formatBoard)}`);
    }
    case 'user-pins': {
      const { items } = await userPins(argument, { limit });
      return print(items, () => list(items, formatPin));
    }
    case 'download': {
      const saved = await downloadImages(rest, values.dir);
      print(saved, () => saved.map(formatSaved).join('\n'));
      if (saved.some((image) => image.error)) process.exitCode = 1;
      return;
    }
  }
}

main().catch((error: Error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
