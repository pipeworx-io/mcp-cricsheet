/**
 * Reads for cricsheet (fleet #2975).
 *
 * Data: Cricsheet (cricsheet.org) -- per-match ball-by-ball JSON files for
 * Test, ODI and T20 International cricket plus the Indian Premier League
 * (ODC Attribution License, ODC-BY). Cricsheet publishes bulk files only, so
 * this pack builds a copy (scripts/cricsheet/load-data.mjs) into a D1
 * database the gateway hands it as `_d1` (pack-manifest "d1Binding":
 * "CRICSHEET_DB"). Each match file is parsed ball-by-ball IN THE LOADER and
 * collapsed to match / innings / batting-card / bowling-card rows --
 * individual deliveries are never stored, per CLAUDE.md "prefer the
 * smallest store that answers the tool questions."
 *
 * Design note: this file + index.ts.
 */

/** The slice of Cloudflare's D1Database this pack uses, declared here so the
 *  pack needs no workers-types and a test can pass a node:sqlite stub. */
export interface D1Like {
  prepare(sql: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...values: unknown[]): D1StmtLike;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
}

export class StoreUnavailableError extends Error {
  constructor() {
    super(
      'cricsheet: the match store is not bound in this runtime (no _d1). These tools only answer through the Pipeworx gateway; a standalone install has no data to read.',
    );
    this.name = 'StoreUnavailableError';
  }
}
export function requireDb(d1: unknown): D1Like {
  if (!d1 || typeof (d1 as D1Like).prepare !== 'function') throw new StoreUnavailableError();
  return d1 as D1Like;
}

export const FORMATS = ['Test', 'ODI', 'T20I', 'IPL'] as const;
export type Format = (typeof FORMATS)[number];

export function resolveFormat(input: unknown): Format | null {
  if (input == null || input === '') return null;
  const s = String(input).trim().toUpperCase();
  const map: Record<string, Format> = {
    TEST: 'Test', TESTS: 'Test',
    ODI: 'ODI', ODIS: 'ODI', 'ONE DAY INTERNATIONAL': 'ODI', 'ONE-DAY INTERNATIONAL': 'ODI',
    T20I: 'T20I', T20IS: 'T20I', T20: 'T20I', 'T20 INTERNATIONAL': 'T20I', 'T20 INTERNATIONALS': 'T20I',
    IPL: 'IPL', 'INDIAN PREMIER LEAGUE': 'IPL',
  };
  return map[s] ?? null;
}

export async function dataAsOf(db: D1Like): Promise<string | null> {
  const r = await db.prepare(`SELECT value FROM cricsheet_meta WHERE key = 'loaded_at'`).first<{ value: string }>();
  return r?.value ?? null;
}

export interface MatchRow {
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
}

export async function getMatch(db: D1Like, matchId: number): Promise<MatchRow | null> {
  return db
    .prepare(
      `SELECT match_id, format, gender, team1, team2, match_date, season, venue, city, event_name,
              toss_winner, toss_decision, outcome_winner, outcome_by_runs, outcome_by_wickets,
              outcome_by_innings, outcome_method, result, player_of_match
       FROM matches WHERE match_id = ?`,
    )
    .bind(matchId)
    .first<MatchRow>();
}

export interface InningsRow {
  innings_num: number;
  batting_team: string;
  total_runs: number;
  total_wickets: number;
  legal_balls: number;
}
export async function getInnings(db: D1Like, matchId: number): Promise<InningsRow[]> {
  const r = await db
    .prepare(`SELECT innings_num, batting_team, total_runs, total_wickets, legal_balls FROM innings WHERE match_id = ? ORDER BY innings_num`)
    .bind(matchId)
    .all<InningsRow>();
  return r.results;
}

export interface BattingCardRow {
  innings_num: number;
  position: number;
  player: string;
  runs: number;
  balls: number;
  fours: number;
  sixes: number;
  not_out: number;
  dismissal_kind: string | null;
  dismissal_bowler: string | null;
}
export async function getBattingCards(db: D1Like, matchId: number): Promise<BattingCardRow[]> {
  const r = await db
    .prepare(
      `SELECT innings_num, position, player, runs, balls, fours, sixes, not_out, dismissal_kind, dismissal_bowler
       FROM batting_cards WHERE match_id = ? ORDER BY innings_num, position`,
    )
    .bind(matchId)
    .all<BattingCardRow>();
  return r.results;
}

export interface BowlingCardRow {
  innings_num: number;
  order_num: number;
  player: string;
  balls: number;
  runs_conceded: number;
  wickets: number;
}
export async function getBowlingCards(db: D1Like, matchId: number): Promise<BowlingCardRow[]> {
  const r = await db
    .prepare(
      `SELECT innings_num, order_num, player, balls, runs_conceded, wickets
       FROM bowling_cards WHERE match_id = ? ORDER BY innings_num, order_num`,
    )
    .bind(matchId)
    .all<BowlingCardRow>();
  return r.results;
}

/** Resolve a free-text player query against the small `players` table
 *  (one row per distinct name string Cricsheet uses). Cricsheet names are
 *  short forms ("V Kohli", "SR Watson") -- matching is case-insensitive
 *  substring, ranked by how many matches that name appears in, so a common
 *  surname like "Kohli" resolves unambiguously while a genuinely ambiguous
 *  query (e.g. a shared surname) comes back as a candidate list rather than
 *  picking one silently. */
export interface PlayerCandidate {
  player: string;
  matches: number;
}
export async function resolvePlayer(db: D1Like, query: string): Promise<{ resolved: string | null; candidates: PlayerCandidate[] }> {
  const exact = await db
    .prepare(`SELECT player, matches FROM players WHERE player = ? COLLATE NOCASE`)
    .bind(query)
    .first<PlayerCandidate>();
  if (exact) return { resolved: exact.player, candidates: [exact] };

  const r = await db
    .prepare(`SELECT player, matches FROM players WHERE player LIKE ? COLLATE NOCASE ORDER BY matches DESC LIMIT 20`)
    .bind(`%${query}%`)
    .all<PlayerCandidate>();
  if (r.results.length === 1) return { resolved: r.results[0].player, candidates: r.results };
  return { resolved: null, candidates: r.results };
}

export interface BattingAgg {
  innings: number;
  runs: number;
  balls: number;
  outs: number;
  not_outs: number;
  fours: number;
  sixes: number;
  high_score: number | null;
  hundreds: number;
  fifties: number;
  average: number | null;
  strike_rate: number | null;
}
export interface BowlingAgg {
  innings: number;
  balls: number;
  runs_conceded: number;
  wickets: number;
  best_wickets: number | null;
  average: number | null;
  economy: number | null;
}

export async function battingAggregate(db: D1Like, player: string, format: Format | null): Promise<BattingAgg> {
  const where = format ? 'player = ? AND format = ?' : 'player = ?';
  const params = format ? [player, format] : [player];
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS innings, COALESCE(SUM(runs),0) AS runs, COALESCE(SUM(balls),0) AS balls,
              COALESCE(SUM(CASE WHEN not_out = 0 THEN 1 ELSE 0 END),0) AS outs,
              COALESCE(SUM(CASE WHEN not_out = 1 THEN 1 ELSE 0 END),0) AS not_outs,
              COALESCE(SUM(fours),0) AS fours, COALESCE(SUM(sixes),0) AS sixes,
              MAX(runs) AS high_score,
              COALESCE(SUM(CASE WHEN runs >= 100 THEN 1 ELSE 0 END),0) AS hundreds,
              COALESCE(SUM(CASE WHEN runs >= 50 AND runs < 100 THEN 1 ELSE 0 END),0) AS fifties
       FROM batting_cards WHERE ${where}`,
    )
    .bind(...params)
    .first<{ innings: number; runs: number; balls: number; outs: number; not_outs: number; fours: number; sixes: number; high_score: number | null; hundreds: number; fifties: number }>();
  const innings = row?.innings ?? 0;
  const runs = row?.runs ?? 0;
  const balls = row?.balls ?? 0;
  const outs = row?.outs ?? 0;
  return {
    innings,
    runs,
    balls,
    outs,
    not_outs: row?.not_outs ?? 0,
    fours: row?.fours ?? 0,
    sixes: row?.sixes ?? 0,
    high_score: row?.high_score ?? null,
    hundreds: row?.hundreds ?? 0,
    fifties: row?.fifties ?? 0,
    average: outs > 0 ? round2(runs / outs) : null,
    strike_rate: balls > 0 ? round2((runs / balls) * 100) : null,
  };
}

export async function bowlingAggregate(db: D1Like, player: string, format: Format | null): Promise<BowlingAgg> {
  const where = format ? 'player = ? AND format = ?' : 'player = ?';
  const params = format ? [player, format] : [player];
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS innings, COALESCE(SUM(balls),0) AS balls, COALESCE(SUM(runs_conceded),0) AS runs_conceded,
              COALESCE(SUM(wickets),0) AS wickets, MAX(wickets) AS best_wickets
       FROM bowling_cards WHERE ${where}`,
    )
    .bind(...params)
    .first<{ innings: number; balls: number; runs_conceded: number; wickets: number; best_wickets: number | null }>();
  const innings = row?.innings ?? 0;
  const balls = row?.balls ?? 0;
  const runs_conceded = row?.runs_conceded ?? 0;
  const wickets = row?.wickets ?? 0;
  return {
    innings,
    balls,
    runs_conceded,
    wickets,
    best_wickets: row?.best_wickets ?? null,
    average: wickets > 0 ? round2(runs_conceded / wickets) : null,
    economy: balls > 0 ? round2(runs_conceded / (balls / 6)) : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface HeadToHeadFilter {
  team_a: string;
  team_b: string;
  format: Format | null;
  limit: number;
  offset: number;
}
export async function headToHeadMatches(db: D1Like, f: HeadToHeadFilter): Promise<MatchRow[]> {
  const where = ['((team1 = ? COLLATE NOCASE AND team2 = ? COLLATE NOCASE) OR (team1 = ? COLLATE NOCASE AND team2 = ? COLLATE NOCASE))'];
  const params: unknown[] = [f.team_a, f.team_b, f.team_b, f.team_a];
  if (f.format) {
    where.push('format = ?');
    params.push(f.format);
  }
  const sql = `SELECT match_id, format, gender, team1, team2, match_date, season, venue, city, event_name,
                      toss_winner, toss_decision, outcome_winner, outcome_by_runs, outcome_by_wickets,
                      outcome_by_innings, outcome_method, result, player_of_match
               FROM matches WHERE ${where.join(' AND ')} ORDER BY match_date DESC LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const r = await db.prepare(sql).bind(...params).all<MatchRow>();
  return r.results;
}
export async function headToHeadCount(db: D1Like, f: Omit<HeadToHeadFilter, 'limit' | 'offset'>): Promise<number> {
  const where = ['((team1 = ? COLLATE NOCASE AND team2 = ? COLLATE NOCASE) OR (team1 = ? COLLATE NOCASE AND team2 = ? COLLATE NOCASE))'];
  const params: unknown[] = [f.team_a, f.team_b, f.team_b, f.team_a];
  if (f.format) {
    where.push('format = ?');
    params.push(f.format);
  }
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM matches WHERE ${where.join(' AND ')}`).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}

export interface FindMatchesFilter {
  team?: string;
  format?: Format | null;
  season?: string;
  venue?: string;
  player?: string;
  limit: number;
  offset: number;
}
export async function findMatches(db: D1Like, f: FindMatchesFilter): Promise<MatchRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.team) {
    where.push('(team1 = ? COLLATE NOCASE OR team2 = ? COLLATE NOCASE)');
    params.push(f.team, f.team);
  }
  if (f.format) {
    where.push('format = ?');
    params.push(f.format);
  }
  if (f.season) {
    where.push('season = ? COLLATE NOCASE');
    params.push(f.season);
  }
  if (f.venue) {
    where.push('venue LIKE ? COLLATE NOCASE');
    params.push(`%${f.venue}%`);
  }
  if (f.player) {
    where.push(
      'match_id IN (SELECT match_id FROM batting_cards WHERE player = ? COLLATE NOCASE UNION SELECT match_id FROM bowling_cards WHERE player = ? COLLATE NOCASE)',
    );
    params.push(f.player, f.player);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT match_id, format, gender, team1, team2, match_date, season, venue, city, event_name,
                      toss_winner, toss_decision, outcome_winner, outcome_by_runs, outcome_by_wickets,
                      outcome_by_innings, outcome_method, result, player_of_match
               FROM matches ${whereSql} ORDER BY match_date DESC LIMIT ? OFFSET ?`;
  params.push(f.limit, f.offset);
  const r = await db.prepare(sql).bind(...params).all<MatchRow>();
  return r.results;
}
export async function findMatchesCount(db: D1Like, f: Omit<FindMatchesFilter, 'limit' | 'offset'>): Promise<number> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.team) {
    where.push('(team1 = ? COLLATE NOCASE OR team2 = ? COLLATE NOCASE)');
    params.push(f.team, f.team);
  }
  if (f.format) {
    where.push('format = ?');
    params.push(f.format);
  }
  if (f.season) {
    where.push('season = ? COLLATE NOCASE');
    params.push(f.season);
  }
  if (f.venue) {
    where.push('venue LIKE ? COLLATE NOCASE');
    params.push(`%${f.venue}%`);
  }
  if (f.player) {
    where.push(
      'match_id IN (SELECT match_id FROM batting_cards WHERE player = ? COLLATE NOCASE UNION SELECT match_id FROM bowling_cards WHERE player = ? COLLATE NOCASE)',
    );
    params.push(f.player, f.player);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM matches ${whereSql}`).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---- compound chase search (fleet #3344) ----------------------------------
export interface ChaseFilter {
  format?: Format | null;
  team?: string;
  gender?: string;
  season?: string;
  event?: string;
  date_from?: string;
  date_to?: string;
  /** 'won' = the side batting second won (a successful chase), 'lost' = it lost, 'any'. */
  second_innings_result: 'won' | 'lost' | 'any';
  min_wickets_remaining?: number;
  max_wickets_remaining?: number;
  min_balls_remaining?: number;
  max_balls_remaining?: number;
  limit: number;
  offset: number;
}
export interface ChaseRow {
  match_id: number;
  format: string;
  gender: string;
  match_date: string;
  season: string | null;
  event_name: string | null;
  venue: string | null;
  team1: string;
  team2: string;
  outcome_winner: string | null;
  outcome_method: string | null;
  result: string | null;
  chasing_team: string;
  target: number;
  chase_runs: number;
  chase_wickets_lost: number;
  chase_legal_balls: number;
  wickets_remaining: number;
  balls_remaining: number | null;
  chase_won: number;
}

function chaseFrom(f: Omit<ChaseFilter, 'limit' | 'offset'>): { sql: string; params: unknown[] } {
  const where: string[] = ['m.format IN (\'ODI\',\'T20I\',\'IPL\')', 'i1.innings_num = 1', 'i2.innings_num = 2'];
  const params: unknown[] = [];
  if (f.second_innings_result === 'won') where.push('m.outcome_winner = i2.batting_team');
  else if (f.second_innings_result === 'lost') where.push('m.outcome_winner IS NOT NULL AND m.outcome_winner <> i2.batting_team');
  if (f.format) { where.push('m.format = ?'); params.push(f.format); }
  if (f.team) { where.push('i2.batting_team = ? COLLATE NOCASE'); params.push(f.team); }
  if (f.gender) { where.push('m.gender = ?'); params.push(f.gender); }
  if (f.season) { where.push('m.season = ? COLLATE NOCASE'); params.push(f.season); }
  if (f.event) { where.push('m.event_name LIKE ? COLLATE NOCASE'); params.push(`%${f.event}%`); }
  if (f.date_from) { where.push('m.match_date >= ?'); params.push(f.date_from); }
  if (f.date_to) { where.push('m.match_date <= ?'); params.push(f.date_to); }
  const wr = '(10 - i2.total_wickets)';
  const br = `(CASE WHEN m.outcome_method IS NOT NULL THEN NULL WHEN m.format = 'ODI' THEN 300 - i2.legal_balls ELSE 120 - i2.legal_balls END)`;
  if (f.min_wickets_remaining != null) { where.push(`${wr} >= ?`); params.push(f.min_wickets_remaining); }
  if (f.max_wickets_remaining != null) { where.push(`${wr} <= ?`); params.push(f.max_wickets_remaining); }
  if (f.min_balls_remaining != null) { where.push(`${br} >= ?`); params.push(f.min_balls_remaining); }
  if (f.max_balls_remaining != null) { where.push(`${br} <= ?`); params.push(f.max_balls_remaining); }
  const sql = `FROM matches m JOIN innings i1 ON i1.match_id = m.match_id JOIN innings i2 ON i2.match_id = m.match_id WHERE ${where.join(' AND ')}`;
  return { sql, params };
}

export async function chaseMatches(db: D1Like, f: ChaseFilter): Promise<ChaseRow[]> {
  const { sql, params } = chaseFrom(f);
  const q = `SELECT m.match_id, m.format, m.gender, m.match_date, m.season, m.event_name, m.venue, m.team1, m.team2,
      m.outcome_winner, m.outcome_method, m.result, i2.batting_team AS chasing_team, i1.total_runs + 1 AS target,
      i2.total_runs AS chase_runs, i2.total_wickets AS chase_wickets_lost, i2.legal_balls AS chase_legal_balls,
      10 - i2.total_wickets AS wickets_remaining,
      CASE WHEN m.outcome_method IS NOT NULL THEN NULL WHEN m.format = 'ODI' THEN 300 - i2.legal_balls ELSE 120 - i2.legal_balls END AS balls_remaining,
      CASE WHEN m.outcome_winner = i2.batting_team THEN 1 ELSE 0 END AS chase_won
    ${sql} ORDER BY m.match_date DESC, m.match_id DESC LIMIT ? OFFSET ?`;
  const r = await db.prepare(q).bind(...params, f.limit, f.offset).all<ChaseRow>();
  return r.results;
}
export async function chaseCount(db: D1Like, f: Omit<ChaseFilter, 'limit' | 'offset'>): Promise<number> {
  const { sql, params } = chaseFrom(f);
  const r = await db.prepare(`SELECT COUNT(*) AS n ${sql}`).bind(...params).first<{ n: number }>();
  return r?.n ?? 0;
}
