# pinterest

Search Pinterest without an account, cookies, API key or browser. Uses the website's JSON endpoints
for logged-out visitors.

Available as:

- **MCP server** (`src/server.ts`) for Claude Code, Claude Desktop, Cursor and other MCP clients
- **CLI** (`src/cli.ts`) for the terminal
- **Library** (`src/pinterest.ts`) for scripts

Requires Node 22.18 or newer. Runs TypeScript directly, without a build step.

```sh
npm install
```

## MCP server

The included `.mcp.json` configures the server for Claude Code in this directory. To register it for all projects:

```sh
claude mcp add --scope user pinterest -- node /absolute/path/to/pinterest/src/server.ts
```

For other MCP clients, run `node <absolute path>/src/server.ts` over stdio.

| Tool | What it does |
| --- | --- |
| `search_pins` | Find pins by keyword, with image URLs and available metadata |
| `related_pins` | "More like this" for a pin, or visual search on any Pinterest image URL |
| `get_pin` | Pin details, with a direct MP4 when available |
| `search_boards` | Find boards by keyword |
| `board_pins` | A board and its pins |
| `user_profile` | A profile and its boards |
| `user_pins` | A user's pins, newest first |
| `suggest_queries` | Get search suggestions |
| `more_results` | Load the next page using a listing's cursor |
| `view_images` | View images at up to 736px wide |
| `download_images` | Save images to disk |

Pin listings include 236px thumbnails for up to 30 pins per call. Pass `preview: false` to omit images.
Each tool also returns structured data with an output schema. Listings contain `kind`, `items`,
`nextCursor` when available, and `warnings`.

Previews are limited to 1 MiB per image and 6 MiB of base64 data per response. Oversized or failed previews
are omitted with warnings; image URLs remain available for download. Downloads allow up to 30 MiB per image.
Clients can cancel requests and request progress updates.

Downloads default to `./pinterest-downloads`. Set `PINTEREST_DOWNLOAD_DIR` or pass `directory` to choose
another location. The CLI uses the same environment variable, overridden by `--dir`.
Downloads preserve existing files. New files become available after writing completes.
The destination filesystem must support hard links, as NTFS and ext4 do.

## CLI

```sh
node src/cli.ts search "japandi bedroom" --limit 10
node src/cli.ts related https://www.pinterest.com/pin/134263632640461792/
node src/cli.ts board archeyesnews/brutalist-architecture --json
node src/cli.ts download https://i.pinimg.com/originals/e3/15/85/e31585a92197413c0868cabb1c3e46e0.jpg --dir ./images
node src/cli.ts help
```

## Library

```ts
import { searchPins } from './src/pinterest.ts';

const { items, next } = await searchPins('retro sci-fi book cover', { limit: 30 });
if (next) {
  const more = await searchPins('retro sci-fi book cover', { limit: 30, cursor: next });
}
```

Use `createClient()` for separate sessions. The exported functions share a default session.
Request options accept `signal` for cancellation and `onProgress(completed, message, total?)` for updates.
Listing limits must be integers from 1 to 100. Board and lookup metadata expire after five minutes;
listed pin references remain in bounded session caches.

The implementation is split into URL parsing (`parse.ts`), response mapping (`normalize.ts`), requests
and pagination (`transport.ts`), ID recovery (`resolve.ts`), and public operations (`pinterest.ts`).
`mcp.ts` creates a server with its own client and cursors; `server.ts` starts it over stdio.

## Tests

```sh
npm test            # offline regression and MCP contract tests
npm run test:live   # live Pinterest requests through the MCP server
npm run typecheck
```

## Limitations

- **Hidden pin IDs.** Search, board and related feeds often return `e1_…` IDs. These work with `get_pin` and
  `related_pins` for pins cached in the current session. If the numeric ID cannot be recovered, `get_pin`
  returns cached details and a save count when available, with a warning; `related_pins` uses visual search.
- **Pin page links.** Recovering a page URL requires a numeric ID. The default lookup checks the board's
  50 newest pins and verifies candidates against the image, board and creation time. Ambiguous matches
  remain unresolved. `find_url: true` on `get_pin` also checks the owner's 1,000 most recent saves.
  These lookups add requests and can take several seconds. Pins from `user_pins` and visual search
  include numeric IDs.
- **Visual-search metadata.** Results omit boards and tags. Use `get_pin` to fetch those details.
- **Unofficial endpoints.** Pinterest's internal endpoints can change or block requests without notice.
  Run `npm run test:live` to check compatibility.
- **Regional results.** Results depend on your IP's country. Tested headers, subdomains and request options
  did not change the region.
- **Videos.** Listings return HLS (`.m3u8`) streams. `get_pin` returns a direct MP4 when available.
- **Rate limits.** Limits are undocumented. A few hundred requests over twenty minutes caused no throttling
  in testing. Requests retry with backoff on HTTP 429/5xx and respect `Retry-After`. A cooldown longer
  than 30 seconds returns an error.
- Images belong to their creators. Finding them here does not grant a licence to reuse them.
