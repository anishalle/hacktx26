// Guess that Lore: the bubble's rules, kept pure so they're testable.
import type { LoreGame, User } from '@/api';

import { firstName } from './format';

export const REVEAL_ANYONE_MS = 24 * 60 * 60 * 1000;

/** `started_by` is a user id; tolerate a full user too. */
export function starterId(game: Pick<LoreGame, 'started_by'>): string {
  const s = game.started_by as string | User | null;
  return typeof s === 'string' ? s : (s?.id ?? '');
}

/** The starter any time; anyone once every member voted or the round is a day old. */
export function canReveal(game: LoreGame, meId: string, startedAt: string, now = Date.now()) {
  if (game.status !== 'open') return false;
  if (starterId(game) === meId) return true;
  if (game.member_count > 0 && game.total_votes >= game.member_count) return true;
  const at = new Date(game.created_at ?? startedAt).getTime();
  return Number.isFinite(at) && now - at >= REVEAL_ANYONE_MS;
}

/** My vote applied locally before the server answers: moves my count to the new pick. */
export function withMyVote(game: LoreGame, choice: string): LoreGame {
  const prev = game.my_vote;
  if (prev === choice || game.status !== 'open') return game;
  return {
    ...game,
    my_vote: choice,
    total_votes: prev ? game.total_votes : game.total_votes + 1,
    options: game.options.map((o) =>
      o.user.id === choice ? { ...o, votes: o.votes + 1 } : o.user.id === prev ? { ...o, votes: Math.max(0, o.votes - 1) } : o,
    ),
  };
}

/** Counts stay hidden until you've voted, so the first guesses aren't herded. */
export const showsCounts = (game: LoreGame) => game.status === 'revealed' || !!game.my_vote;

export function votedLine(game: LoreGame) {
  if (game.member_count > 0) return `${game.total_votes} of ${game.member_count} voted`;
  return game.total_votes === 1 ? '1 vote' : `${game.total_votes} votes`;
}

/** "You got it!", "Not quite: it was Dad", "It was Dad". */
export function resultLine(game: LoreGame, meId: string) {
  const answer = game.answer;
  if (!answer) return null;
  const name = answer.id === meId ? 'you' : firstName(answer.display_name);
  if (game.my_vote && game.my_vote === answer.id) return 'You got it!';
  if (game.my_vote) return `Not quite: it was ${name}`;
  return `It was ${name}`;
}

/** A response or frame never takes a revealed round back to open. */
export function newerGame(current: LoreGame | null | undefined, next: LoreGame) {
  if (current?.status === 'revealed' && next.status === 'open') return current;
  return next;
}
