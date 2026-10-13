# @pipeworx/cricsheet

Ball-by-ball cricket data collapsed to the questions people actually ask: a
match's result and scorecard, a player's career batting/bowling aggregates,
and a head-to-head record between two teams. Covers Test matches, One Day
Internationals, T20 Internationals, and the Indian Premier League. Fleet
#2975.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1784+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `cricsheet_match(match_id)` — one match's full result plus, for every
  innings, the batting card (each batter's runs/balls/4s/6s/how out) and
  bowling card (each bowler's overs/runs/wickets). Use
  `cricsheet_find_matches` first to get a `match_id`.
- `cricsheet_player_stats(player, format?)` — a cricketer's career batting
  and bowling aggregates (matches, runs, average, strike rate, 100s/50s;
  wickets, bowling average, economy). `player` is matched case-insensitively
  as a substring against the short-form names this pack stores (e.g. "Kohli"
  for "V Kohli"); an ambiguous query returns a candidate list instead of
  guessing. Optionally scope to one `format`.
- `cricsheet_head_to_head(team_a, team_b, format?, limit?, offset?)` — total
  matches, each team's wins, ties/no-results, and the most recent matches
  with their results. Team names must match Cricsheet's own strings (e.g.
  `"India"`, `"Mumbai Indians"`).
- `cricsheet_find_matches(team?, format?, season?, venue?, player?, limit?, offset?)`
  — search the match index to discover `match_id`s. With no filters, returns
  the most recent matches held across every format.

`format` accepts `"Test"`, `"ODI"`, `"T20I"` (international T20), or `"IPL"`
(case-insensitive); omit it to search across all four.

**What this pack does not do:** it does not return individual deliveries
(ball-by-ball). Every match file is parsed ball-by-ball once, at load time,
and collapsed into match / innings / batting-card / bowling-card rows —
storing every ball for ~11,000 matches would multiply the row count by
roughly 150-200x for a question ("who scored what, who took which wickets")
that the scorecard already answers.

## Auth

Keyless. The tools answer only through the Pipeworx gateway, which holds the
data; a standalone `npm install` has no data to read, and every tool throws
a clear "not bound in this runtime" error there instead of returning an
empty list.

## Data sources

- Cricsheet — ball-by-ball match data for Test cricket, One Day
  Internationals, T20 Internationals, and the Indian Premier League.
  **Licence: ODC Attribution License (ODC-BY)** — free to share, adapt and
  use (including commercially) with attribution to Cricsheet. Cricsheet
  publishes bulk per-match files only (no live API), so this pack builds a
  copy (`scripts/cricsheet/load-data.mjs`) into a D1 database rather than
  proxying per request, per CLAUDE.md's "build the copy" rule for a
  bulk-only source.

### Known gaps — read before extending this pack

**Only four of Cricsheet's ~60 competitions are loaded.** Cricsheet also
publishes first-class, List A, and ~50 domestic T20 leagues (Big Bash, T20
Blast, Pakistan Super League, Caribbean Premier League, The Hundred, and so
on) as separate bulk files. This pack loads the four with the clearest
cross-format demand (international Test/ODI/T20I plus the IPL, the league
named explicitly in the originating demand signal). Adding another league is
one more entry in `BULK_FILES` in the loader, using the same
match-type-agnostic parser.

**Women's matches are included wherever Cricsheet's own bulk file includes
them**, distinguished by the `gender` field Cricsheet carries per match — not
filtered out, not separately tooled.

**Player identity is the raw name string Cricsheet uses** (e.g. "V Kohli",
"SR Watson") — short forms, not full names, and this pack does not maintain
its own name-to-person mapping beyond what `cricsheet_player_stats`'s
substring match provides. Two different people sharing a short-form name
(rare, but not impossible across ~8,400 distinct names) would merge under
that string; nothing in Cricsheet's own files beyond the registry ID (not
currently loaded) resolves that.

**Super overs are stored as extra innings entries**, exactly as Cricsheet's
own `innings` array represents them (a tied T20 can have 3 or 4 innings
entries) — `cricsheet_match` returns whatever innings Cricsheet's file has,
including super-over ones.

### Refreshing or extending the data

Re-run `node scripts/cricsheet/load-data.mjs` (needs `wrangler` logged in to
the Pipeworx Cloudflare account, and `CLOUDFLARE_ACCOUNT_ID` set when more
than one account is visible) — it re-fetches every format live and replaces
every table (DROP + reload), because Cricsheet corrects historical files
rather than versioning them. `--only <Test|ODI|T20I|IPL>` reloads a single
format; `--dry-run` parses and prints counts without touching D1, useful
after changing the parser. Cricsheet adds new matches continuously (for
international and IPL cricket, typically within a day of the match); re-run
the loader periodically to pick those up — `data_as_of` in every tool
response names the load it is reading.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "cricsheet": {
      "url": "https://gateway.pipeworx.io/cricsheet/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/cricsheet/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1784+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/cricsheet_match \
  -H 'Content-Type: application/json' \
  -d '{"match_id":1082591}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/cricsheet_match`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "cricsheet": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-cricsheet"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-cricsheet
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Cricsheet data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
