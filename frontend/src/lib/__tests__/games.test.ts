import type { LoreGame, User } from '@/api';

import { canReveal, newerGame, REVEAL_ANYONE_MS, resultLine, showsCounts, starterId, votedLine, withMyVote } from '../games';

const user = (id: string, display_name: string): User => ({
  id,
  username: id,
  display_name,
  avatar_url: null,
  phonetic_hint: null,
  pronunciation_audio_url: null,
});
const dad = user('ravi', 'Ravi Varma');
const mom = user('lakshmi', 'Lakshmi Varma');
const diya = user('diya', 'Diya Varma');

const base: LoreGame = {
  id: 1,
  group_id: 3,
  message_id: 40,
  lore_id: 9,
  prompt: 'Someone’s victory lap in the parking lot',
  question: 'Who was it?',
  hints: [],
  hints_total: 3,
  options: [
    { user: dad, votes: 1, voters: [] },
    { user: mom, votes: 0, voters: [] },
    { user: diya, votes: 0, voters: [] },
  ],
  my_vote: null,
  total_votes: 1,
  member_count: 4,
  status: 'open',
  answer: null,
  lore_title: null,
  started_by: 'diya',
  can_reveal: false,
};
const startedAt = '2026-10-25T12:00:00Z';
const at = (ms: number) => new Date(startedAt).getTime() + ms;

test('the starter reveals any time; others once everyone voted or after a day', () => {
  expect(canReveal(base, 'diya', startedAt, at(0))).toBe(true);
  expect(canReveal(base, 'ravi', startedAt, at(60_000))).toBe(false);
  expect(canReveal({ ...base, total_votes: 4 }, 'ravi', startedAt, at(0))).toBe(true);
  expect(canReveal(base, 'ravi', startedAt, at(REVEAL_ANYONE_MS))).toBe(true);
  expect(canReveal({ ...base, status: 'revealed' }, 'diya', startedAt, at(0))).toBe(false);
  expect(starterId({ started_by: diya as unknown as string })).toBe('diya');
});

test('my vote moves between options locally', () => {
  const first = withMyVote(base, 'lakshmi');
  expect(first.my_vote).toBe('lakshmi');
  expect(first.total_votes).toBe(2);
  expect(first.options.map((o) => o.votes)).toEqual([1, 1, 0]);
  const moved = withMyVote(first, 'ravi');
  expect(moved.total_votes).toBe(2);
  expect(moved.options.map((o) => o.votes)).toEqual([2, 0, 0]);
  expect(withMyVote({ ...base, status: 'revealed' }, 'ravi').my_vote).toBeNull();
});

test('counts stay hidden until you vote; result lines read naturally', () => {
  expect(showsCounts(base)).toBe(false);
  expect(showsCounts({ ...base, my_vote: 'ravi' })).toBe(true);
  expect(votedLine(base)).toBe('1 of 4 voted');
  const revealed: LoreGame = { ...base, status: 'revealed', answer: dad, lore_title: 'Dad’s 59.7 MPG Victory Lap' };
  expect(showsCounts(revealed)).toBe(true);
  expect(resultLine({ ...revealed, my_vote: 'ravi' }, 'diya')).toBe('You got it!');
  expect(resultLine({ ...revealed, my_vote: 'lakshmi' }, 'diya')).toBe('Not quite: it was Ravi');
  expect(resultLine(revealed, 'ravi')).toBe('It was you');
  expect(resultLine(base, 'diya')).toBeNull();
});

test('a late answer never takes a revealed round back to open', () => {
  const revealed: LoreGame = { ...base, status: 'revealed', answer: dad };
  expect(newerGame(revealed, base)).toBe(revealed);
  expect(newerGame(base, revealed)).toBe(revealed);
  expect(newerGame(null, base)).toBe(base);
});
