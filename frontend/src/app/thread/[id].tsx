import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ListViewToken,
  type TextInputInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, type Message, type User } from '@/api';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { GlassCircle } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { CatchupPill } from '@/components/thread/CatchupPill';
import { Composer } from '@/components/thread/Composer';
import { NudgeBanner } from '@/components/thread/NudgeBanner';
import { MessageRow, SeenBy, SystemLine, TimeSeparator, type RunPos } from '@/components/thread/rows';
import { HEADER_ROW, ThreadHeader } from '@/components/thread/ThreadHeader';
import { Wallpaper } from '@/components/thread/Wallpaper';
import { useExplain } from '@/features/explain';
import { useNudge } from '@/hooks/useNudge';
import { useThread } from '@/hooks/useThread';
import { firstName, separatorLabel, shortAge } from '@/lib/format';
import { catchupMarkRead, threadJump } from '@/state/bus';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors, mixHex } from '@/theme';

const CATCHUP_MIN = 50;
const GAP_FOR_SEPARATOR_MS = 60 * 60 * 1000;

// Instagram's outgoing gradient runs blue (bottom of the screen) → violet → purple (top).
function tintFor(rowsFromBottom: number) {
  const t = Math.max(0, Math.min(1, rowsFromBottom / 12));
  return t < 0.5 ? mixHex(colors.gradBottom, colors.gradMid, t * 2) : mixHex(colors.gradMid, colors.gradTop, (t - 0.5) * 2);
}

type Item =
  | { type: 'sep'; key: string; label: string }
  | { type: 'system'; key: string; m: Message }
  | { type: 'msg'; key: string; m: Message; run: RunPos; showName: boolean; showAvatar: boolean }
  | { type: 'seen'; key: string; users: User[] };

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id: string; unread?: string; name?: string }>();
  const groupId = Number(params.id);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { userById } = useSession();
  const inbox = useInbox();
  const onExplain = useExplain();
  const t = useThread(groupId, me.id);
  const listRef = useRef<FlatList<Item>>(null);
  const inputRef = useRef<TextInputInstance>(null);

  // ---- Catch-up pill ------------------------------------------------------------------------
  const [catchup, setCatchup] = useState<{ count: number; since: number | null } | null>(() => {
    const n = Number(params.unread ?? 0);
    return n >= CATCHUP_MIN ? { count: n, since: null } : null;
  });
  useEffect(() => {
    let cancelled = false;
    api
      .catchupPreview(groupId, me.id)
      .then((p) => {
        if (cancelled) return;
        setCatchup(p.eligible || p.unread_count >= CATCHUP_MIN ? { count: p.unread_count, since: p.since_message_id } : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupId, me.id]);
  const pillVisible = !!catchup;

  // ---- Read state ---------------------------------------------------------------------------
  const focused = useRef(true);
  const [focusTick, setFocusTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      setFocusTick((n) => n + 1);
      return () => {
        focused.current = false;
      };
    }, []),
  );
  const [newestVisible, setNewestVisible] = useState<number | null>(null);
  const lastReadSent = useRef(0);
  const markRead = useCallback(
    (messageId: number) => {
      if (messageId <= lastReadSent.current) return;
      lastReadSent.current = messageId;
      api.markRead(groupId, { user_id: me.id, message_id: messageId }).catch(() => {
        lastReadSent.current = 0;
      });
      inbox.markReadLocal(groupId, messageId);
    },
    [groupId, me.id, inbox],
  );
  useEffect(() => {
    // Catch-up must not change read state while its pill is up.
    if (pillVisible || !focused.current || newestVisible === null || AppState.currentState !== 'active') return;
    markRead(newestVisible);
  }, [newestVisible, pillVisible, focusTick, markRead]);

  useEffect(
    () =>
      catchupMarkRead.on(({ groupId: g }) => {
        if (g !== groupId) return;
        setCatchup(null);
        const newest = t.messages.filter((m) => m.id > 0).at(-1);
        if (newest) markRead(newest.id);
      }),
    [groupId, t.messages, markRead],
  );

  // Index of the bottom-most visible row: outgoing bubbles are tinted by screen position from here.
  const [bottomIndex, setBottomIndex] = useState(0);
  const onViewable = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    let max = 0;
    let minIndex = Infinity;
    for (const v of viewableItems) {
      if (v.index !== null && v.index !== undefined && v.index < minIndex) minIndex = v.index;
      const it = v.item as Item;
      if ((it.type === 'msg' || it.type === 'system') && it.m.id > max) max = it.m.id;
    }
    if (max > 0) setNewestVisible((prev) => (prev === null || max > prev ? max : prev));
    if (minIndex !== Infinity) setBottomIndex(minIndex);
  }, []);

  // ---- Jump to a message (catch-up bullet) -----------------------------------------------------
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);
  useEffect(
    () =>
      threadJump.on(async ({ groupId: g, messageId }) => {
        if (g !== groupId) return;
        try {
          await t.jumpTo(messageId);
        } catch {
          return;
        }
        pendingScroll.current = messageId;
        setHighlightId(null);
        setTimeout(() => setHighlightId(messageId), 50);
      }),
    [groupId, t],
  );

  // ---- Rows ----------------------------------------------------------------------------------
  const members = t.group?.members;
  const names = useMemo(() => {
    const s = new Set<string>();
    members?.forEach((mem) => {
      s.add(mem.user.id.toLowerCase());
      s.add(mem.user.username.toLowerCase());
      s.add(firstName(mem.user.display_name).toLowerCase());
    });
    return s;
  }, [members]);

  const items = useMemo<Item[]>(() => {
    const asc = t.messages;
    const out: Item[] = [];
    const sepBefore = (i: number) =>
      i === 0 || new Date(asc[i].ts).getTime() - new Date(asc[i - 1].ts).getTime() > GAP_FOR_SEPARATOR_MS;
    for (let i = 0; i < asc.length; i++) {
      const m = asc[i];
      if (sepBefore(i)) out.push({ type: 'sep', key: `sep-${m.id}`, label: separatorLabel(m.ts) });
      if (m.kind === 'system') {
        out.push({ type: 'system', key: `m-${m.id}`, m });
        continue;
      }
      const prev = asc[i - 1];
      const next = asc[i + 1];
      const joinsPrev = !!prev && prev.kind === 'text' && prev.sender_id === m.sender_id && !sepBefore(i);
      const joinsNext = !!next && next.kind === 'text' && next.sender_id === m.sender_id && !sepBefore(i + 1);
      const run: RunPos = joinsPrev ? (joinsNext ? 'middle' : 'last') : joinsNext ? 'first' : 'single';
      const mine = m.sender_id === me.id;
      out.push({
        type: 'msg',
        key: `m-${m.id}`,
        m,
        run,
        showName: !mine && !joinsPrev && !t.group?.is_dm,
        showAvatar: !mine && !joinsNext,
      });
    }
    const newest = [...asc].reverse().find((m) => m.id > 0 && m.kind === 'text');
    if (newest && members && !t.hasMoreAfter) {
      const seen = members
        .filter((mem) => mem.user.id !== me.id && mem.user.id !== newest.sender_id && (mem.last_read_message_id ?? 0) >= newest.id)
        .map((mem) => mem.user);
      if (seen.length) out.push({ type: 'seen', key: 'seen', users: seen });
    }
    return out.reverse();
  }, [t.messages, t.group?.is_dm, t.hasMoreAfter, members, me.id]);

  // Scroll to a jumped-to message once it's in the list.
  useEffect(() => {
    const target = pendingScroll.current;
    if (target === null) return;
    const index = items.findIndex((it) => (it.type === 'msg' || it.type === 'system') && it.m.id === target);
    if (index === -1) return;
    pendingScroll.current = null;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }));
  }, [items]);

  const messageById = useMemo(() => new Map(t.messages.map((m) => [m.id, m])), [t.messages]);

  // ---- Composer + nudge ------------------------------------------------------------------------
  const [draft, setDraft] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const hasNewcomers = !!members?.some((mem) => mem.is_newcomer && mem.user.id !== me.id);
  const sendNow = useCallback(
    async (text: string) => {
      const reply = replyTo?.id ?? null;
      setDraft('');
      setReplyTo(null);
      try {
        const saved = await t.send(text, reply);
        markRead(saved.id);
        listRef.current?.scrollToOffset({ offset: 0, animated: true });
      } catch (e) {
        setDraft(text);
        Alert.alert('Message not sent', e instanceof Error ? e.message : String(e));
      }
    },
    [replyTo, t, markRead],
  );
  const nudge = useNudge({ groupId, userId: me.id, hasNewcomers, draft, setDraft, onSend: sendNow });

  const [kbVisible, setKbVisible] = useState(false);
  useEffect(() => {
    const a = Keyboard.addListener('keyboardWillShow', () => setKbVisible(true));
    const b = Keyboard.addListener('keyboardWillHide', () => setKbVisible(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);

  // ---- Scroll position: bottom detection dismisses the pill; FAB to jump back ------------------
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const wasAway = useRef(false);
  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const y = e.nativeEvent.contentOffset.y;
    if (y > 400) wasAway.current = true;
    const away = y > 500;
    if (away !== awayFromBottom) setAwayFromBottom(away);
  };
  const onScrollSettled = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (e.nativeEvent.contentOffset.y < 40 && wasAway.current && !t.hasMoreAfter && catchup) {
      // The member scrolled through to the bottom themselves: now reading counts.
      setCatchup(null);
    }
  };

  const jumpToLatest = async () => {
    Haptics.selectionAsync();
    if (t.hasMoreAfter) await t.loadLatest();
    listRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const openCatchup = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({
      pathname: '/catchup',
      params: { groupId: String(groupId), ...(catchup?.since ? { since: String(catchup.since) } : {}) },
    });
  };

  const onReact = useCallback(
    (m: Message, emoji: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      t.toggleReaction(m, emoji);
    },
    [t],
  );
  const onReply = useCallback((m: Message) => {
    setReplyTo(m);
    setTimeout(() => inputRef.current?.focus(), 350);
  }, []);
  const onCopy = useCallback((m: Message) => {
    Clipboard.setStringAsync(m.text);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);
  const explainMessage = useCallback((m: Message) => onExplain({ groupId, message: m }), [onExplain, groupId]);

  // ---- Header text ---------------------------------------------------------------------------
  const group = t.group;
  const title = group?.name ?? params.name ?? '';
  const [openedAt] = useState(() => Date.now());
  const subtitle = useMemo(() => {
    if (!group) return '';
    // Prefer the live window; when viewing history (after a jump) fall back to the inbox's latest message.
    const latestInbox = inbox.items.find((it) => it.group.id === groupId)?.last_message;
    const fromWindow = t.hasMoreAfter
      ? undefined
      : [...t.messages].reverse().find((m) => m.kind === 'text' && m.sender_id && m.sender_id !== me.id);
    const lastOther = fromWindow ?? (latestInbox && latestInbox.sender_id !== me.id ? latestInbox : undefined);
    if (group.is_dm) return lastOther ? `Active ${shortAge(lastOther.ts)} ago` : 'Instagram';
    if (lastOther && openedAt - new Date(lastOther.ts).getTime() < 24 * 3600 * 1000) {
      const who = userById(lastOther.sender_id);
      return `${who ? firstName(who.display_name) : 'Someone'} was active ${shortAge(lastOther.ts)} ago`;
    }
    return `${group.member_count} members`;
  }, [group, t.messages, t.hasMoreAfter, inbox.items, groupId, me.id, userById, openedAt]);

  const headerHeight = insets.top + 2 + HEADER_ROW;

  const renderItem = ({ item, index }: { item: Item; index: number }) => {
    switch (item.type) {
      case 'sep':
        return <TimeSeparator label={item.label} />;
      case 'system':
        return <SystemLine text={item.m.text} names={names} />;
      case 'seen':
        return <SeenBy users={item.users} isDm={!!group?.is_dm} />;
      case 'msg': {
        const m = item.m;
        const mine = m.sender_id === me.id;
        const replied = m.reply_to ? messageById.get(m.reply_to) : undefined;
        const repliedSender = replied ? userById(replied.sender_id) : undefined;
        return (
          <MessageRow
            message={m}
            mine={mine}
            sender={userById(m.sender_id)}
            showName={item.showName}
            showAvatar={item.showAvatar}
            run={item.run}
            tint={tintFor(index - bottomIndex)}
            highlighted={highlightId === m.id}
            replied={
              m.reply_to
                ? {
                    name: replied?.sender_id === me.id ? 'you' : (repliedSender?.username ?? 'a message'),
                    text: replied?.text ?? 'Original message',
                  }
                : null
            }
            userById={userById}
            onReact={onReact}
            onReply={onReply}
            onCopy={onCopy}
            onExplain={explainMessage}
          />
        );
      }
    }
  };

  const intro = group ? (
    <View style={[styles.intro, { paddingTop: headerHeight + (pillVisible ? 60 : 24) }]}>
      {group.is_dm || group.avatar_url ? <Avatar uri={group.avatar_url} size={92} /> : <GroupAvatar uris={[null, null]} size={92} />}
      <Text style={styles.introTitle}>{group.name}</Text>
      <Text style={styles.introSub}>{group.is_dm ? 'Instagram' : `${group.member_count} members`}</Text>
    </View>
  ) : null;

  return (
    <View style={styles.screen}>
      <Wallpaper />
      <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
        {t.status === 'loading' ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.textSecondary} />
          </View>
        ) : t.status === 'error' ? (
          <View style={styles.center}>
            <Text style={styles.errorText}>Couldn’t load this chat.{'\n'}{t.error}</Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            inverted
            keyExtractor={(it) => it.key}
            renderItem={renderItem}
            onEndReached={t.loadOlder}
            onEndReachedThreshold={1.5}
            onStartReached={t.loadNewer}
            onStartReachedThreshold={1}
            maintainVisibleContentPosition={t.hasMoreAfter ? { minIndexForVisible: 1 } : undefined}
            onViewableItemsChanged={onViewable}
            viewabilityConfig={{ itemVisiblePercentThreshold: 60 }}
            onScroll={onScroll}
            scrollEventThrottle={64}
            onScrollEndDrag={onScrollSettled}
            onMomentumScrollEnd={onScrollSettled}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              listRef.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
              setTimeout(() => listRef.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 120);
            }}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingTop: 10 }}
            ListFooterComponent={
              t.hasMoreBefore ? (
                <View style={{ paddingTop: headerHeight + 40, paddingBottom: 16 }}>
                  <ActivityIndicator color={colors.textSecondary} />
                </View>
              ) : (
                (intro ?? undefined)
              )
            }
            initialNumToRender={24}
            windowSize={15}
          />
        )}
        {awayFromBottom || t.hasMoreAfter ? (
          <View style={styles.fab}>
            <GlassCircle size={38} onPress={jumpToLatest} accessibilityLabel="Jump to latest">
              <Icon name="chevron.down" size={15} weight="semibold" />
            </GlassCircle>
          </View>
        ) : null}
        <View style={{ paddingBottom: kbVisible ? 4 : insets.bottom }}>
          {nudge.banner ? (
            <NudgeBanner
              banner={nudge.banner}
              onRewrite={nudge.rewrite}
              onKeepMine={nudge.keepMine}
              onAddAside={nudge.openAside}
              onSubmitAside={nudge.submitAside}
              onDismiss={nudge.dismiss}
            />
          ) : null}
          <Composer
            ref={inputRef}
            value={draft}
            onChangeText={setDraft}
            highlights={nudge.highlights}
            sendLabel={nudge.sendLabel}
            sending={nudge.checkingUnknown}
            onSend={nudge.send}
            reply={
              replyTo
                ? {
                    name: replyTo.sender_id === me.id ? 'yourself' : (userById(replyTo.sender_id)?.username ?? ''),
                    text: replyTo.text,
                  }
                : null
            }
            onCancelReply={() => setReplyTo(null)}
          />
        </View>
      </KeyboardAvoidingView>
      <ThreadHeader
        title={title}
        subtitle={subtitle}
        avatarUrl={group?.avatar_url ?? null}
        isGroup={!!group && !group.is_dm}
        onBack={() => router.back()}
      />
      {catchup ? <CatchupPill count={catchup.count} top={headerHeight + 6} onPress={openCatchup} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#18191C' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText: { color: colors.textSecondary, textAlign: 'center', fontSize: 15 },
  intro: { alignItems: 'center', paddingBottom: 24, gap: 6 },
  introTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 8 },
  introSub: { color: colors.textSecondary, fontSize: 14 },
  fab: { position: 'absolute', right: 14, bottom: 120 },
});
