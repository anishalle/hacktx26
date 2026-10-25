import { mockApi } from '../mock';
import { maskTitle } from '../mock/games';

// Guess that Lore in the mock: name-free prompts, one vote per member, hints, reveal rules.
describe('mock Guess that Lore', () => {
  const me = 'anish';

  async function vbGroup() {
    const inbox = await mockApi.getInbox(me);
    const vb = inbox.find((i) => i.group.name === 'volleyball')!;
    return mockApi.getGroup(vb.group.id, me);
  }

  test('masks member names', () => {
    expect(maskTitle("Swayam's house becomes Grandma's", 1)).toBe("Someone's house becomes Grandma's");
    expect(maskTitle('Leo names the usual spot', 1)).toBe('Someone names the usual spot');
  });

  test('starts a round with a name-free prompt and member options', async () => {
    const g = await vbGroup();
    const m = await mockApi.startGame(g.id, me);
    expect(m.kind).toBe('game');
    const game = m.game!;
    expect(game.status).toBe('open');
    expect(game.hints).toEqual([]);
    expect(game.hints_total).toBe(3);
    expect(game.options.length).toBeGreaterThanOrEqual(2);
    expect(game.options.length).toBeLessThanOrEqual(4);
    const memberIds = new Set(g.members.map((x) => x.user.id));
    expect(game.options.every((o) => memberIds.has(o.user.id))).toBe(true);
    for (const mem of g.members) {
      const first = mem.user.display_name.split(' ')[0];
      expect(game.prompt.toLowerCase()).not.toMatch(new RegExp(`\\b${first.toLowerCase()}\\b`));
    }
    const page = await mockApi.getMessages(g.id, { user_id: me, limit: 5 });
    expect(page.messages.at(-1)?.game?.id).toBe(game.id);
  });

  test('votes, hints and the reveal follow the rules', async () => {
    const g = await vbGroup();
    const game = (await mockApi.startGame(g.id, me)).game!;
    const [a, b] = game.options.map((o) => o.user.id);

    let v = await mockApi.voteGame(game.id, { user_id: me, choice: a });
    expect(v.my_vote).toBe(a);
    v = await mockApi.voteGame(game.id, { user_id: me, choice: b });
    expect(v.total_votes).toBe(1);
    expect(v.options.find((o) => o.user.id === b)?.votes).toBe(1);
    expect(v.options.every((o) => o.voters.length === 0)).toBe(true);
    await expect(mockApi.voteGame(game.id, { user_id: 'nobody', choice: a })).rejects.toThrow('not a member');
    await expect(mockApi.voteGame(game.id, { user_id: me, choice: 'nobody' })).rejects.toThrow('Not one of the options');

    expect((await mockApi.hintGame(game.id, me)).hints).toHaveLength(1);
    await mockApi.hintGame(game.id, me);
    await mockApi.hintGame(game.id, me);
    await expect(mockApi.hintGame(game.id, me)).rejects.toMatchObject({ status: 409 }); // none left

    const other = g.members.find((x) => x.user.id !== me)!.user.id;
    await expect(mockApi.revealGame(game.id, other)).rejects.toThrow('Only the starter');

    const others = g.members.map((x) => x.user.id).filter((id) => id !== me);
    let last = v;
    for (const id of others) last = await mockApi.voteGame(game.id, { user_id: id, choice: a });
    expect(last.status).toBe('revealed');
    expect(last.answer).not.toBeNull();
    expect(last.lore_title).toBeTruthy();
    expect(last.options.reduce((n, o) => n + o.voters.length, 0)).toBe(g.members.length);
    await expect(mockApi.voteGame(game.id, { user_id: me, choice: a })).rejects.toThrow('already revealed');

    const page = await mockApi.getMessages(g.id, { user_id: me, limit: 3 });
    expect(page.messages.at(-1)?.text).toMatch(/^🎉 It was /);
  });
});
