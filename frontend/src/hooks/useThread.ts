import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type GroupDetail, type Message, type Reaction } from '@/api';
import { useRealtime } from '@/state/realtime';

const PAGE = 50;

type State = {
  messages: Message[]; // ascending
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
};

/** Paged message window for one thread, kept live by realtime frames. */
export function useThread(groupId: number, meId: string) {
  const [group, setGroup] = useState<GroupDetail | null>(null);
  const [state, setState] = useState<State>({ messages: [], hasMoreBefore: false, hasMoreAfter: false });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const loadingOlder = useRef(false);
  const loadingNewer = useRef(false);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const tempId = useRef(-1);

  const loadLatest = useCallback(async () => {
    const page = await api.getMessages(groupId, { limit: PAGE });
    setState({ messages: page.messages, hasMoreBefore: page.has_more_before, hasMoreAfter: false });
  }, [groupId]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([api.getGroup(groupId, meId), api.getMessages(groupId, { limit: PAGE })])
      .then(([g, page]) => {
        if (cancelled) return;
        setGroup(g);
        setState({ messages: page.messages, hasMoreBefore: page.has_more_before, hasMoreAfter: page.has_more_after });
        setStatus('ready');
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [groupId, meId]);

  const loadOlder = useCallback(async () => {
    const s = stateRef.current;
    if (loadingOlder.current || !s.hasMoreBefore || !s.messages.length) return;
    loadingOlder.current = true;
    try {
      const page = await api.getMessages(groupId, { before: s.messages[0].id, limit: PAGE });
      setState((prev) => {
        const known = new Set(prev.messages.map((m) => m.id));
        return {
          ...prev,
          messages: [...page.messages.filter((m) => !known.has(m.id)), ...prev.messages],
          hasMoreBefore: page.has_more_before,
        };
      });
    } catch {
      // keep what we have; the next scroll retries
    } finally {
      loadingOlder.current = false;
    }
  }, [groupId]);

  const loadNewer = useCallback(async () => {
    const s = stateRef.current;
    if (loadingNewer.current || !s.hasMoreAfter || !s.messages.length) return;
    loadingNewer.current = true;
    try {
      const last = s.messages.filter((m) => m.id > 0).at(-1);
      if (!last) return;
      const page = await api.getMessages(groupId, { after: last.id, limit: PAGE });
      setState((prev) => {
        const known = new Set(prev.messages.map((m) => m.id));
        return {
          ...prev,
          messages: [...prev.messages, ...page.messages.filter((m) => !known.has(m.id))],
          hasMoreAfter: page.has_more_after,
        };
      });
    } catch {
      // ignore
    } finally {
      loadingNewer.current = false;
    }
  }, [groupId]);

  /** Replace the window with one centered on `messageId` (catch-up "jump to where this happened"). */
  const jumpTo = useCallback(
    async (messageId: number) => {
      if (stateRef.current.messages.some((m) => m.id === messageId)) return;
      const page = await api.getMessages(groupId, { around: messageId, limit: 60 });
      setState({ messages: page.messages, hasMoreBefore: page.has_more_before, hasMoreAfter: page.has_more_after });
    },
    [groupId],
  );

  useRealtime((frame) => {
    if (frame.type === 'message.new' && frame.data.group_id === groupId) {
      const m = frame.data;
      setState((prev) => {
        if (prev.messages.some((x) => x.id === m.id)) return prev;
        if (prev.hasMoreAfter) return prev; // viewing history; "jump to latest" will pick it up
        // Replace our optimistic copy if this is the echo of our own send.
        const tempIdx = prev.messages.findIndex(
          (x) => x.id < 0 && x.sender_id === m.sender_id && x.kind === m.kind && x.text === m.text,
        );
        if (tempIdx !== -1) {
          const next = [...prev.messages];
          next[tempIdx] = m;
          return { ...prev, messages: next };
        }
        return { ...prev, messages: [...prev.messages, m] };
      });
    } else if (frame.type === 'reaction.updated' && frame.data.group_id === groupId) {
      const { message_id, reactions } = frame.data;
      setState((prev) => ({
        ...prev,
        messages: prev.messages.map((m) => (m.id === message_id ? { ...m, reactions } : m)),
      }));
    } else if (frame.type === 'read.updated' && frame.data.group_id === groupId) {
      const { user_id, message_id } = frame.data;
      setGroup((g) =>
        g
          ? {
              ...g,
              members: g.members.map((mem) =>
                mem.user.id === user_id && (mem.last_read_message_id ?? 0) < message_id
                  ? { ...mem, last_read_message_id: message_id }
                  : mem,
              ),
            }
          : g,
      );
    }
  });

  /** Optimistic send: a negative-id copy shows at once and is swapped for the saved message. */
  const sendWith = useCallback(
    async (temp: Message, save: () => Promise<Message>) => {
      if (stateRef.current.hasMoreAfter) await loadLatest();
      setState((prev) => ({ ...prev, messages: [...prev.messages, temp] }));
      try {
        const saved = await save();
        setState((prev) => {
          const without = prev.messages.filter((m) => m.id !== temp.id);
          if (without.some((m) => m.id === saved.id)) return { ...prev, messages: without };
          return { ...prev, messages: [...without, saved].sort((a, b) => a.id - b.id || 0) };
        });
        return saved;
      } catch (e) {
        setState((prev) => ({ ...prev, messages: prev.messages.filter((m) => m.id !== temp.id) }));
        throw e;
      }
    },
    [loadLatest],
  );

  const send = useCallback(
    (text: string, replyTo: number | null) => {
      const temp: Message = {
        id: tempId.current--,
        group_id: groupId,
        sender_id: meId,
        kind: 'text',
        text,
        ts: new Date().toISOString(),
        reply_to: replyTo,
        reactions: [],
      };
      return sendWith(temp, () => api.sendMessage(groupId, { sender_id: meId, text, reply_to: replyTo }));
    },
    [groupId, meId, sendWith],
  );

  /** `photo` is the image picker's local file; it shows from disk until the upload finishes. */
  const sendPhoto = useCallback(
    (photo: { uri: string; width: number; height: number }, text: string, replyTo: number | null) => {
      const temp: Message = {
        id: tempId.current--,
        group_id: groupId,
        sender_id: meId,
        kind: 'photo',
        text,
        ts: new Date().toISOString(),
        reply_to: replyTo,
        reactions: [],
        image: { url: photo.uri, width: photo.width, height: photo.height },
        image_description: null,
      };
      return sendWith(temp, () =>
        api.sendPhoto(groupId, { sender_id: meId, ...photo, text: text || undefined, reply_to: replyTo }),
      );
    },
    [groupId, meId, sendWith],
  );

  const toggleReaction = useCallback(
    async (message: Message, emoji: string) => {
      if (message.id < 0) return;
      const apply = (reactions: Reaction[]) =>
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((m) => (m.id === message.id ? { ...m, reactions } : m)),
        }));
      const had = message.reactions.some((r) => r.user_id === meId && r.emoji === emoji);
      apply(
        had
          ? message.reactions.filter((r) => !(r.user_id === meId && r.emoji === emoji))
          : [...message.reactions, { user_id: meId, emoji }],
      );
      try {
        const saved = await api.toggleReaction(groupId, message.id, { user_id: meId, emoji });
        apply(saved.reactions);
      } catch {
        apply(message.reactions);
      }
    },
    [groupId, meId],
  );

  return {
    group,
    status,
    error,
    ...state,
    loadOlder,
    loadNewer,
    loadLatest,
    jumpTo,
    send,
    sendPhoto,
    toggleReaction,
  };
}
