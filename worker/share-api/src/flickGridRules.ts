/**
 * FlickGrid's constraints, and whether a title meets one.
 *
 * ⚠️ MIRRORS flickto-web/lib/games/flickgrid.ts. Two implementations, one contract, and the
 * failure mode is the one this repo already has a fixture file for: they disagree, the
 * client draws a cell green, the server rejects the pick, and the player's score changes
 * on reload with nothing in any log. Documents and Resources/Tests/game/grid-fixtures.json pins both.
 *
 * The client is the one that must be generous-but-correct at fill time; THIS is the
 * authority, because it is what the stored score is derived from.
 */

import type { IndexedTitle } from "./titleIndex";

export type Constraint =
  | { kind: "decade"; decade: number }
  | { kind: "genre"; slug: string }
  | { kind: "minRating"; tenths: number }
  | { kind: "type"; type: number }
  | { kind: "runtimeUnder"; minutes: number }
  | { kind: "runtimeOver"; minutes: number };

/**
 * MUST match GENRE_SLUGS in catalogMeta.ts, GenreBitmask.kt, the generator and the web's
 * copy. Same slugs, same order, append-only -- the bit index IS the contract, so
 * reordering silently changes what every stored mask means.
 */
const GENRE_SLUGS = [
  "action", "adventure", "animation", "comedy", "crime", "documentary", "drama",
  "family", "fantasy", "history", "horror", "music", "mystery", "romance",
  "science-fiction", "tv-movie", "thriller", "war", "western", "children",
  "news", "reality", "soap", "talk-show", "anime",
  "donghua", "game-show", "holiday", "musical", "short", "special-interest", "superhero", "suspense",
];

/**
 * Whether a mask carries a slug.
 *
 * ⚠️ BigInt. The vocabulary runs to 33 slugs and the top one is bit 32, while a JS bitwise
 * operator coerces to a 32-bit SIGNED int -- so `mask & (1 << 32)` reads the wrong bit and
 * does it silently, for exactly one genre out of thirty-three. The same trap is documented
 * at length in the web's oneTake.ts.
 */
export function hasGenre(genreMask: number, slug: string): boolean {
  const bit = GENRE_SLUGS.indexOf(slug);
  if (bit < 0) return false;
  return (BigInt(genreMask) & (1n << BigInt(bit))) !== 0n;
}

/**
 * ⚠️ Runtime constraints always return FALSE, on both sides.
 *
 * Runtime is not in the published title index -- it is (title, year, type, genreMask,
 * ratingTenths, tmdbId) -- so neither the client nor this can check one against a guess.
 * The kinds stay in the union because the shape is real and dropping them invites someone
 * to reinvent them wrongly; the generator must never emit one. Returning false fails
 * CLOSED: a valid answer is rejected, never an invalid one accepted.
 */
export function satisfies(title: IndexedTitle, c: Constraint): boolean {
  switch (c.kind) {
    case "decade":
      return Math.floor(title.year / 10) * 10 === c.decade;
    case "genre":
      return hasGenre(title.genreMask, c.slug);
    case "minRating":
      return title.ratingTenths > 0 && title.ratingTenths >= c.tenths;
    case "type":
      return title.type === c.type;
    case "runtimeUnder":
    case "runtimeOver":
      return false;
  }
}

export type GridSpec = {
  rows: Constraint[];
  cols: Constraint[];
  /**
   * The right poster for each cell, in reading order.
   *
   * The board became a matching puzzle: a tray of posters, exactly one of which fits each
   * cell. Scoring is therefore "is this the right poster", not "does this title satisfy
   * the constraints" — those agreed while any valid title counted, and stopped agreeing
   * the moment the pool guaranteed a single right answer per square.
   *
   * Optional so an archived board written before the change still verifies the old way.
   */
  solution?: number[];
};

/** Cell index 0..8 in reading order to its pair of constraints. */
export function constraintsForCell(spec: GridSpec, cell: number): [Constraint, Constraint] | null {
  const row = Math.floor(cell / 3);
  const col = cell % 3;
  if (!spec.rows[row] || !spec.cols[col]) return null;
  return [spec.rows[row], spec.cols[col]];
}

export function fitsCell(title: IndexedTitle, spec: GridSpec, cell: number): boolean {
  const pair = constraintsForCell(spec, cell);
  if (!pair) return false;
  return satisfies(title, pair[0]) && satisfies(title, pair[1]);
}
