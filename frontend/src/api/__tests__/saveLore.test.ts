import { mockApi } from '../mock';

// "Save to Lore" in the mock: kept at once, titled with the saved line, idempotent.
describe('mock saveLore', () => {
  const me = 'anish';

  test('keeps the moment around a message, once', async () => {
    const [inbox] = await mockApi.getInbox(me);
    const groupId = inbox.group.id;
    const page = await mockApi.getMessages(groupId, { limit: 200 });
    const held = new Set((await mockApi.getLoreFeed(me, { group_id: groupId, limit: 50 })).items.flatMap((l) => l.events.map((e) => e.message?.id)));
    const saved = page.messages.find((m) => m.kind === 'text' && m.text.trim() && !held.has(m.id))!;

    const l = await mockApi.saveLore(groupId, saved.id, me);
    expect(l.status).toBe('kept');
    expect(l.kept_by?.id).toBe(me);
    const words = saved.text.split(/\s+/).filter(Boolean).join(' ');
    expect(l.title).toBe(words.length <= 48 ? words : `${words.slice(0, 47).trimEnd()}…`);
    expect(l.events.some((e) => e.message?.id === saved.id || e.snippets.some((s) => s.message_id === saved.id))).toBe(true);

    expect((await mockApi.saveLore(groupId, saved.id, 'swayam')).id).toBe(l.id);
    expect((await mockApi.getLoreFeed(me, { group_id: groupId, limit: 50 })).items.filter((x) => x.id === l.id)).toHaveLength(1);
  });

  test('members only, real messages only', async () => {
    const [inbox] = await mockApi.getInbox(me);
    const page = await mockApi.getMessages(inbox.group.id, { limit: 5 });
    await expect(mockApi.saveLore(inbox.group.id, page.messages[0].id, 'nobody')).rejects.toThrow('not a member');
    await expect(mockApi.saveLore(inbox.group.id, -1, me)).rejects.toThrow('Message not found');
  });
});
