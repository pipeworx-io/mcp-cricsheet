interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * cricsheet -- ball-by-ball cricket data collapsed to match / player / team
 * questions (fleet #2975).
 *
 * Data: Cricsheet (cricsheet.org) -- per-match JSON files for Test, One Day
 * International and Twenty20 International cricket plus the Indian Premier
 * League (ODC Attribution License, ODC-BY; attribution: Cricsheet). Cricsheet
 * publishes bulk files only, so this pack builds a copy
 * (scripts/cricsheet/load-data.mjs) into a D1 database the gateway hands it
 * as `_d1` (pack-manifest "d1Binding": "CRICSHEET_DB"). Design note: this
 * file + store.ts.
 *
 * Every match file is parsed ball-by-ball IN THE LOADER and collapsed to
 * match, innings, and batting/bowling scorecard rows -- individual
 * deliveries are not stored or served (CLAUDE.md "prefer the smallest store
 * that answers the tool questions; do not store every ball if aggregates
 * answer the questions").
 *
 * Every response carries `source`, `source_url`, `license` and `data_as_of`.
 */
import {
  battingAggregate,
  bowlingAggregate,
  dataAsOf,
  findMatches,
  findMatchesCount,
  getBattingCards,
  getBowlingCards,
  getInnings,
  getMatch,
  headToHeadCount,
  headToHeadMatches,
  requireDb,
  resolveFormat,
  resolvePlayer,
  type D1Like,
  type Format,
} from './store.js';

const SOURCE = 'Cricsheet, ball-by-ball cricket match data';
const SOURCE_URL = 'https://cricsheet.org';
const LICENSE = 'ODC-BY (Open Data Commons Attribution License); attribution: Cricsheet';

const FORMAT_DESC = 'Match format: "Test", "ODI", "T20I" (international T20), or "IPL". Omit to search across every format this pack holds.';

const tools: McpToolExport['tools'] = [
  {
    name: 'cricsheet_match',
    description:
      'Full result and scorecard for one cricket match: teams, venue, date, toss, result, and for every innings the batting card (each batter\'s runs/balls/4s/6s/how out) and bowling card (each bowler\'s overs/runs/wickets). Covers Test, ODI and T20 International cricket plus the IPL (Cricsheet, ODC-BY). Use cricsheet_find_matches first to get a match_id if you don\'t already have one.',
    summary: "One match's full result and batting/bowling scorecards by match_id.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        match_id: { type: 'number', description: 'Cricsheet match id, e.g. 1082591. Get one from cricsheet_find_matches.' },
      },
      required: ['match_id'],
    },
  },
  {
    name: 'cricsheet_player_stats',
    description:
      'A cricketer\'s career batting and bowling aggregates (matches, runs, average, strike rate, 100s/50s; wickets, bowling average, economy) from Cricsheet\'s Test/ODI/T20I/IPL match data. Pass a name or partial name ("Kohli", "V Kohli") -- Cricsheet stores short-form names, so this matches case-insensitively and returns a candidate list if the name is ambiguous. Optionally scope to one format with `format`. Covers only matches Cricsheet has scored ball-by-ball, not a player\'s entire career.',
    summary: "A cricketer's batting/bowling career aggregates, optionally scoped to one format.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        player: { type: 'string', description: 'Player name or partial name, e.g. "Kohli" or "V Kohli".' },
        format: { type: 'string', description: FORMAT_DESC },
      },
      required: ['player'],
    },
  },
  {
    name: 'cricsheet_head_to_head',
    description:
      'Head-to-head record between two cricket teams from Cricsheet\'s Test/ODI/T20I/IPL match data: total matches, each team\'s wins, ties/no-results, and the most recent matches with their results. Pass team names as Cricsheet uses them, e.g. "India", "Australia", "Mumbai Indians" (IPL). Optionally scope to one format with `format`.',
    summary: 'Win/loss head-to-head record between two teams, optionally scoped to one format.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team_a: { type: 'string', description: 'First team name, e.g. "India".' },
        team_b: { type: 'string', description: 'Second team name, e.g. "Australia".' },
        format: { type: 'string', description: FORMAT_DESC },
        limit: { type: 'number', description: 'Max recent matches to list, 1-100. Default 10.' },
        offset: { type: 'number', description: 'Pagination offset into the recent-matches list. Default 0.' },
      },
      required: ['team_a', 'team_b'],
    },
  },
  {
    name: 'cricsheet_find_matches',
    description:
      'Search Cricsheet\'s Test/ODI/T20I/IPL match index by team, format, season, venue and/or player, returning match_id plus date/teams/venue/result for each hit -- use this to discover match_ids for cricsheet_match. With no filters, returns the most recent matches across every format. Provide at least one filter to narrow a specific search.',
    summary: 'Search matches by team/format/season/venue/player to get match_ids.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        team: { type: 'string', description: 'Team name, e.g. "England" or "Chennai Super Kings" (IPL).' },
        format: { type: 'string', description: FORMAT_DESC },
        season: { type: 'string', description: 'Season label as Cricsheet records it, e.g. "2023" or "2007/08".' },
        venue: { type: 'string', description: 'Venue name or partial venue name, e.g. "Lord\'s".' },
        player: { type: 'string', description: 'Exact player name as Cricsheet stores it (see cricsheet_player_stats to resolve a partial name first).' },
        limit: { type: 'number', description: 'Max matches to return, 1-200. Default 50.' },
        offset: { type: 'number', description: 'Pagination offset. Default 0.' },
      },
    },
  },
];

function clampInt(v: unknown, lo: number, hi: number, d: number): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
}
function str(v: unknown): string | null {
  return v != null && v !== '' ? String(v).trim() : null;
}

function serializeMatch(m: {
  match_id: number;
  format: string;
  gender: string;
  team1: string;
  team2: string;
  match_date: string;
  season: string | null;
  venue: string | null;
  city: string | null;
  event_name: string | null;
  toss_winner: string | null;
  toss_decision: string | null;
  outcome_winner: string | null;
  outcome_by_runs: number | null;
  outcome_by_wickets: number | null;
  outcome_by_innings: number | null;
  outcome_method: string | null;
  result: string | null;
  player_of_match: string | null;
}) {
  return {
    match_id: m.match_id,
    format: m.format,
    gender: m.gender,
    team1: m.team1,
    team2: m.team2,
    match_date: m.match_date,
    season: m.season,
    venue: m.venue,
    city: m.city,
    event: m.event_name,
    toss: m.toss_winner ? { winner: m.toss_winner, decision: m.toss_decision } : null,
    outcome: {
      winner: m.outcome_winner,
      by_runs: m.outcome_by_runs,
      by_wickets: m.outcome_by_wickets,
      by_innings: m.outcome_by_innings === 1,
      method: m.outcome_method,
      result: m.result,
    },
    player_of_match: m.player_of_match,
  };
}

async function cricsheetMatchTool(db: D1Like, args: Record<string, unknown>) {
  const asOf = await dataAsOf(db);
  const matchId = Math.floor(Number(args.match_id));
  if (!Number.isFinite(matchId)) {
    return { found: false, reason: 'invalid_match_id', message: 'match_id must be a number.', data_as_of: asOf };
  }
  const match = await getMatch(db, matchId);
  if (!match) {
    return {
      found: false,
      reason: 'not_found',
      match_id: matchId,
      message: `No match held with match_id=${matchId}.`,
      hint: 'Call cricsheet_find_matches to search by team/format/season/venue and get a valid match_id.',
      data_as_of: asOf,
    };
  }
  const [innings, batting, bowling] = await Promise.all([getInnings(db, matchId), getBattingCards(db, matchId), getBowlingCards(db, matchId)]);
  const inningsOut = innings.map((inn) => ({
    innings: inn.innings_num,
    batting_team: inn.batting_team,
    total_runs: inn.total_runs,
    total_wickets: inn.total_wickets,
    overs: `${Math.floor(inn.legal_balls / 6)}.${inn.legal_balls % 6}`,
    batting_card: batting
      .filter((b) => b.innings_num === inn.innings_num)
      .map((b) => ({
        position: b.position,
        player: b.player,
        runs: b.runs,
        balls: b.balls,
        fours: b.fours,
        sixes: b.sixes,
        not_out: b.not_out === 1,
        dismissal: b.not_out === 1 ? 'not out' : b.dismissal_kind ? `${b.dismissal_kind}${b.dismissal_bowler ? ` b ${b.dismissal_bowler}` : ''}` : null,
      })),
    bowling_card: bowling
      .filter((b) => b.innings_num === inn.innings_num)
      .map((b) => ({
        order: b.order_num,
        player: b.player,
        overs: `${Math.floor(b.balls / 6)}.${b.balls % 6}`,
        runs_conceded: b.runs_conceded,
        wickets: b.wickets,
        economy: b.balls > 0 ? Math.round((b.runs_conceded / (b.balls / 6)) * 100) / 100 : null,
      })),
  }));
  return {
    found: true,
    ...serializeMatch(match),
    innings: inningsOut,
    source: SOURCE,
    source_url: SOURCE_URL,
    license: LICENSE,
    data_as_of: asOf,
  };
}

async function cricsheetPlayerStatsTool(db: D1Like, args: Record<string, unknown>) {
  const asOf = await dataAsOf(db);
  const query = str(args.player);
  if (!query) {
    return { found: false, reason: 'missing_player', message: 'player is required.', data_as_of: asOf };
  }
  let format: Format | null = null;
  if (args.format != null && args.format !== '') {
    format = resolveFormat(args.format);
    if (!format) {
      return { found: false, reason: 'unknown_format', message: `${JSON.stringify(args.format)} is not a recognized format. Use "Test", "ODI", "T20I", or "IPL".`, data_as_of: asOf };
    }
  }
  const { resolved, candidates } = await resolvePlayer(db, query);
  if (!resolved) {
    if (!candidates.length) {
      return {
        found: false,
        reason: 'no_match',
        message: `No player matching ${JSON.stringify(query)} held in this pack.`,
        hint: 'Cricsheet uses short-form names (e.g. "V Kohli", "SR Watson") -- try a surname or a shorter fragment.',
        data_as_of: asOf,
      };
    }
    return {
      found: false,
      reason: 'ambiguous',
      message: `${JSON.stringify(query)} matches ${candidates.length} players.`,
      candidates: candidates.map((c) => ({ player: c.player, matches: c.matches })),
      hint: 'Call again with the exact player string from candidates.',
      data_as_of: asOf,
    };
  }
  const [batting, bowling] = await Promise.all([battingAggregate(db, resolved, format), bowlingAggregate(db, resolved, format)]);
  if (batting.innings === 0 && bowling.innings === 0) {
    return {
      found: false,
      reason: 'no_data_for_format',
      player: resolved,
      format: format ?? 'all',
      message: `${resolved} has no ${format ?? 'Cricsheet'} innings held in this pack.`,
      hint: format ? 'Try again without format to search across every format.' : undefined,
      data_as_of: asOf,
    };
  }
  return {
    found: true,
    player: resolved,
    format: format ?? 'all',
    batting,
    bowling,
    source: SOURCE,
    source_url: SOURCE_URL,
    license: LICENSE,
    data_as_of: asOf,
  };
}

async function cricsheetHeadToHeadTool(db: D1Like, args: Record<string, unknown>) {
  const asOf = await dataAsOf(db);
  const teamA = str(args.team_a);
  const teamB = str(args.team_b);
  if (!teamA || !teamB) {
    return { found: false, reason: 'missing_team', message: 'team_a and team_b are both required.', data_as_of: asOf };
  }
  let format: Format | null = null;
  if (args.format != null && args.format !== '') {
    format = resolveFormat(args.format);
    if (!format) {
      return { found: false, reason: 'unknown_format', message: `${JSON.stringify(args.format)} is not a recognized format. Use "Test", "ODI", "T20I", or "IPL".`, data_as_of: asOf };
    }
  }
  const limit = clampInt(args.limit, 1, 100, 10);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const filter = { team_a: teamA, team_b: teamB, format, limit, offset };
  const [rows, total] = await Promise.all([headToHeadMatches(db, filter), headToHeadCount(db, filter)]);
  if (!total) {
    return {
      found: false,
      reason: 'no_match',
      team_a: teamA,
      team_b: teamB,
      format: format ?? 'all',
      message: `No matches held between ${teamA} and ${teamB}${format ? ` in ${format}` : ''}.`,
      hint: 'Check team spelling (Cricsheet uses full names, e.g. "India" not "IND") or call cricsheet_find_matches with team= to see what is held.',
      data_as_of: asOf,
    };
  }
  let winsA = 0, winsB = 0, ties = 0, noResult = 0;
  for (const m of rows) {
    if (m.result === 'tie') ties++;
    else if (m.result) noResult++;
    else if (m.outcome_winner && m.outcome_winner.toLowerCase() === teamA.toLowerCase()) winsA++;
    else if (m.outcome_winner && m.outcome_winner.toLowerCase() === teamB.toLowerCase()) winsB++;
  }
  const truncated = rows.length < total;
  return {
    found: true,
    team_a: teamA,
    team_b: teamB,
    format: format ?? 'all',
    total_matching: total,
    returned: rows.length,
    truncated,
    ...(truncated ? { hint: 'More matches exist than were returned (recent-matches list only). Page with limit/offset.' } : {}),
    recent_matches_summary: { wins_in_returned_set: { [teamA]: winsA, [teamB]: winsB }, ties, no_result_or_draw: noResult },
    recent_matches: rows.map(serializeMatch),
    source: SOURCE,
    source_url: SOURCE_URL,
    license: LICENSE,
    data_as_of: asOf,
  };
}

async function cricsheetFindMatchesTool(db: D1Like, args: Record<string, unknown>) {
  const asOf = await dataAsOf(db);
  let format: Format | null = null;
  if (args.format != null && args.format !== '') {
    format = resolveFormat(args.format);
    if (!format) {
      return { found: false, reason: 'unknown_format', message: `${JSON.stringify(args.format)} is not a recognized format. Use "Test", "ODI", "T20I", or "IPL".`, data_as_of: asOf };
    }
  }
  const limit = clampInt(args.limit, 1, 200, 50);
  const offset = Math.max(0, Math.floor(Number(args.offset) || 0));
  const filter = {
    team: str(args.team) ?? undefined,
    format,
    season: str(args.season) ?? undefined,
    venue: str(args.venue) ?? undefined,
    player: str(args.player) ?? undefined,
    limit,
    offset,
  };
  const [rows, total] = await Promise.all([findMatches(db, filter), findMatchesCount(db, filter)]);
  if (!total) {
    return {
      found: false,
      reason: 'no_match',
      message: 'No matches held matching those filters.',
      hint: 'Loosen a filter -- venue is substring-matched, but team/season/player require the exact string Cricsheet uses.',
      data_as_of: asOf,
    };
  }
  const truncated = rows.length < total;
  return {
    found: true,
    total_matching: total,
    returned: rows.length,
    truncated,
    ...(truncated ? { hint: 'More matches exist than were returned. Narrow with team/format/season/venue/player, or page with limit/offset.' } : {}),
    matches: rows.map(serializeMatch),
    source: SOURCE,
    source_url: SOURCE_URL,
    license: LICENSE,
    data_as_of: asOf,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const bound = requireDb(args._d1);
  switch (name) {
    case 'cricsheet_match':
      return cricsheetMatchTool(bound, args);
    case 'cricsheet_player_stats':
      return cricsheetPlayerStatsTool(bound, args);
    case 'cricsheet_head_to_head':
      return cricsheetHeadToHeadTool(bound, args);
    case 'cricsheet_find_matches':
      return cricsheetFindMatchesTool(bound, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
