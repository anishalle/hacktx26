import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect, useIsPreview, useLocalSearchParams, useRouter } from 'expo-router';
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
  type ListViewToken,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type TextInputInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, type Lore, type Message, type User } from '@/api';
import { Avatar, GroupAvatar } from '@/components/Avatar';
import { GlassCircle } from '@/components/GlassCircle';
import { Icon } from '@/components/Icon';
import { CallBar } from '@/components/thread/CallBar';
import { LoreSuggestionCard } from '@/components/thread/LoreSuggestionCard';
import { CatchupPill } from '@/components/thread/CatchupPill';
import { Composer } from '@/components/thread/Composer';
import { NudgeBanner } from '@/components/thread/NudgeBanner';
import { PhotoViewer } from '@/components/thread/PhotoViewer';
import { MessageRow, SeenBy, SystemLine, TimeSeparator, type RunPos } from '@/components/thread/rows';
import { HEADER_ROW, ThreadHeader } from '@/components/thread/ThreadHeader';
import { Wallpaper } from '@/components/thread/Wallpaper';
import { useExplain } from '@/features/explain';
import { useGroupCall } from '@/hooks/useGroupCall';
import { useNudge } from '@/hooks/useNudge';
import { useThread } from '@/hooks/useThread';
import { firstName } from '@/lib/format';
import { catchupMarkRead, threadJump } from '@/state/bus';
import { useInbox } from '@/state/inbox';
import { useRealtime } from '@/state/realtime';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

const CATCHUP_MIN = 50;

/** The photos a kept moment shows: its photo events and its image row. */
const lorePhotoIds = (l: Lore) => [
  ...new Set([...l.events.filter((e) => e.kind === 'photo' && e.message).map((e) => e.message!.id), ...l.media.map((m) => m.id)]),
];
const GAP_FOR_SEPARATOR_MS = 60 * 60 * 1000;

type Item =
  | { type: 'sep'; key: string; ts: string }
  | { type: 'system'; key: string; m: Message }
  | { type: 'msg'; key: string; m: Message; run: RunPos; showName: boolean; showAvatar: boolean }
  | { type: 'seen'; key: string; users: User[]; readAt: number | null; delivered: boolean }
  | { type: 'lore'; key: string; lore: Lore };

export default function ThreadScreen() {
  const params = useLocalSearchParams<{ id: string; unread?: string; name?: string; around?: string }>();
  const groupId = Number(params.id);
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const me = useMe();
  const { userById } = useSession();
  const inbox = useInbox();
  const onExplain = useExplain();
  // A peek from the inbox (Link.Preview) renders this screen too: it must not mark anything read,
  // show the catch-up pill or listen to realtime; the composer and overlays stay hidden.
  const isPreview = useIsPreview();
  const t = useThread(groupId, me.id, { live: !isPreview });
  const listRef = useRef<FlatList<Item>>(null);
  const inputRef = useRef<TextInputInstance>(null);

  // ---- Catch-up pill ------------------------------------------------------------------------
  const [catchup, setCatchup] = useState<{ count: number; since: number | null } | null>(() => {
    const n = Number(params.unread ?? 0);
    return n >= CATCHUP_MIN && !isPreview ? { count: n, since: null } : null;
  });
  useEffect(() => {
    if (isPreview) return;
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
  }, [groupId, me.id, isPreview]);
  const pillVisible = !!catchup;

  // ---- Read state ---------------------------------------------------------------------------
  // Starts false: a peek prefetches this route as a real (non-preview) screen that never gains
  // focus, and it must not mark anything read until the user actually opens the thread.
  const focused = useRef(false);
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
      if (isPreview || messageId <= lastReadSent.current) return;
      lastReadSent.current = messageId;
      api.markRead(groupId, { user_id: me.id, message_id: messageId }).catch(() => {
        lastReadSent.current = 0;
      });
      inbox.markReadLocal(groupId, messageId);
    },
    [groupId, me.id, inbox, isPreview],
  );
  useEffect(() => {
    // Catch-up must not change read state while its pill is up.
    if (pillVisible || !focused.current || newestVisible === null || AppState.currentState !== 'active') return;
    markRead(newestVisible);
  }, [newestVisible, pillVisible, focusTick, markRead]);

  useEffect(
    () =>
      catchupMarkRead.on(({ groupId: g }) => {
        if (g !== groupId || isPreview) return;
        setCatchup(null);
        const newest = t.messages.filter((m) => m.id > 0).at(-1);
        if (newest) markRead(newest.id);
      }),
    [groupId, t.messages, markRead, isPreview],
  );

  const onViewable = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    let max = 0;
    for (const v of viewableItems) {
      const it = v.item as Item;
      if ((it.type === 'msg' || it.type === 'system') && it.m.id > max) max = it.m.id;
    }
    if (max > 0) setNewestVisible((prev) => (prev === null || max > prev ? max : prev));
  }, []);

  // A DM's "Read 3:29 PM": the read time is only known when this session sees the receipt arrive.
  const [readSeen, setReadSeen] = useState<{ messageId: number; at: number } | null>(null);
  useRealtime((frame) => {
    if (isPreview || frame.type !== 'read.updated' || frame.data.group_id !== groupId || frame.data.user_id === me.id) return;
    const messageId = frame.data.message_id;
    setReadSeen((prev) => (prev && prev.messageId >= messageId ? prev : { messageId, at: Date.now() }));
  });

  // ---- Jump to a message (catch-up bullet) -----------------------------------------------------
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const pendingScroll = useRef<number | null>(null);
  useEffect(
    () =>
      threadJump.on(async ({ groupId: g, messageId }) => {
        if (g !== groupId || isPreview) return;
        try {
          await t.jumpTo(messageId);
        } catch {
          return;
        }
        pendingScroll.current = messageId;
        setHighlightId(null);
        setTimeout(() => setHighlightId(messageId), 50);
      }),
    [groupId, t, isPreview],
  );

  // ---- Opened at a message (Lore's "What was said") -----------------------------------------------
  const jumpedToParam = useRef(false);
  useEffect(() => {
    if (!params.around || jumpedToParam.current || t.status !== 'ready') return;
    jumpedToParam.current = true;
    threadJump.emit({ groupId, messageId: Number(params.around) });
  }, [params.around, t.status, groupId]);

  // ---- Kept moments: photos that anchor one get a sparkles badge -----------------------------------
  const [keptPhotos, setKeptPhotos] = useState<Map<number, number[]>>(() => new Map()); // lore id → its photos
  const noteKept = useCallback((l: Lore) => {
    const ids = l.status === 'kept' ? lorePhotoIds(l) : [];
    setKeptPhotos((prev) => {
      if (!ids.length && !prev.has(l.id)) return prev;
      const next = new Map(prev);
      if (ids.length) next.set(l.id, ids);
      else next.delete(l.id);
      return next;
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    api
      .getLoreFeed(me.id, { group_id: groupId, kind: 'photo', limit: 50 })
      .then((feed) => !cancelled && setKeptPhotos(new Map(feed.items.map((l) => [l.id, lorePhotoIds(l)]))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupId, me.id]);
  const keptPhotoIds = useMemo(() => new Set([...keptPhotos.values()].flat()), [keptPhotos]);

  const [viewing, setViewing] = useState<Message | null>(null); // the photo open full screen
  const saveToLore = useCallback(
    async (m: Message) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      try {
        const l = await api.saveLore(groupId, m.id, me.id);
        noteKept(l);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        Alert.alert('Saved to Lore', l.title, [
          { text: 'OK', style: 'cancel' },
          {
            text: 'View',
            onPress: () => {
              setViewing(null);
              router.push({ pathname: '/lore/[id]', params: { id: String(l.id) } });
            },
          },
        ]);
      } catch (e) {
        Alert.alert('Couldn’t save it', e instanceof Error ? e.message : String(e));
      }
    },
    [groupId, me.id, noteKept, router],
  );

  // ---- Lore suggestions: "Keep this as lore?" under the moment's messages -------------------------
  const [loreSuggestions, setLoreSuggestions] = useState<Lore[]>([]);
  useEffect(() => {
    if (isPreview) return;
    let cancelled = false;
    api
      .getLoreSuggestions(groupId, me.id)
      .then((list) => !cancelled && setLoreSuggestions(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [groupId, me.id, isPreview]);
  useRealtime((frame) => {
    if (isPreview || frame.type !== 'lore.updated' || frame.data.group_id !== groupId) return;
    const l = frame.data;
    noteKept(l);
    if (l.source !== 'chat') return;
    setLoreSuggestions((prev) =>
      l.status === 'suggested' ? [...prev.filter((p) => p.id !== l.id), l] : prev.filter((p) => p.id !== l.id),
    );
  });
  const keepLore = useCallback(
    async (l: Lore) => {
      try {
        await api.keepLore(l.id, me.id);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      } catch (e) {
        Alert.alert('Couldn’t keep it', e instanceof Error ? e.message : String(e));
      }
      setLoreSuggestions((prev) => prev.filter((p) => p.id !== l.id));
    },
    [me.id],
  );
  const dismissLore = useCallback(
    (l: Lore) => {
      setLoreSuggestions((prev) => prev.filter((p) => p.id !== l.id));
      api.dismissLore(l.id, me.id).catch(() => {});
    },
    [me.id],
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
      if (sepBefore(i)) out.push({ type: 'sep', key: `sep-${m.id}`, ts: m.ts });
      if (m.kind === 'system') {
        out.push({ type: 'system', key: `m-${m.id}`, m });
        continue;
      }
      const prev = asc[i - 1];
      const next = asc[i + 1];
      const joinsPrev = !!prev && prev.kind !== 'system' && prev.sender_id === m.sender_id && !sepBefore(i);
      const joinsNext = !!next && next.kind !== 'system' && next.sender_id === m.sender_id && !sepBefore(i + 1);
      const run: RunPos = joinsPrev ? (joinsNext ? 'middle' : 'last') : joinsNext ? 'first' : 'single';
      const mine = m.sender_id === me.id;
      out.push({
        type: 'msg',
        key: `m-${m.id}`,
        m,
        run,
        showName: !mine && !joinsPrev && !t.group?.is_dm,
        showAvatar: !mine && !joinsNext && !t.group?.is_dm,
      });
      for (const l of loreSuggestions) if (l.anchor_message_id === m.id) out.push({ type: 'lore', key: `lore-${l.id}`, lore: l });
    }
    const newest = [...asc].reverse().find((m) => m.id > 0 && m.kind !== 'system');
    if (newest && members && !t.hasMoreAfter) {
      const seen = members
        .filter(
          (mem) => mem.user.id !== me.id && mem.user.id !== newest.sender_id && (mem.last_read_message_id ?? 0) >= newest.id,
        )
        .map((mem) => mem.user);
      const mineNewest = newest.sender_id === me.id;
      const readAt = readSeen && readSeen.messageId >= newest.id ? readSeen.at : null;
      if (seen.length || (mineNewest && t.group?.is_dm))
        out.push({ type: 'seen', key: 'seen', users: seen, readAt, delivered: mineNewest });
    }
    return out.reverse();
  }, [t.messages, t.group?.is_dm, t.hasMoreAfter, members, me.id, loreSuggestions, readSeen]);

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

  // ---- Photos ----------------------------------------------------------------------------------
  const [attachment, setAttachment] = useState<{ uri: string; width: number; height: number } | null>(null);
  const pickPhoto = useCallback(async () => {
    // quality < 1 makes iOS hand back a JPEG, which is what the upload expects.
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.8 });
    const asset = res.canceled ? null : res.assets[0];
    if (asset) setAttachment({ uri: asset.uri, width: asset.width, height: asset.height });
  }, []);
  // The simulator has no camera: launchCameraAsync rejects there, so offer Photos instead.
  const takePhoto = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Camera Access Is Off', 'Allow camera access in Settings to take a photo here.');
        return;
      }
      const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.8 });
      const asset = res.canceled ? null : res.assets[0];
      if (asset) setAttachment({ uri: asset.uri, width: asset.width, height: asset.height });
    } catch {
      Alert.alert('No Camera Available', 'This device can’t take photos. Choose one from your library instead.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Choose Photo', onPress: pickPhoto },
      ]);
    }
  }, [pickPhoto]);
  // A photo skips the nudge checks: its caption goes out as typed.
  const sendPhotoNow = useCallback(async () => {
    if (!attachment) return;
    const photo = attachment;
    const caption = draft.trim();
    const reply = replyTo?.id ?? null;
    setAttachment(null);
    setDraft('');
    setReplyTo(null);
    try {
      const saved = await t.sendPhoto(photo, caption, reply);
      markRead(saved.id);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
    } catch (e) {
      setAttachment(photo);
      setDraft(caption);
      Alert.alert('Photo not sent', e instanceof Error ? e.message : String(e));
    }
  }, [attachment, draft, replyTo, t, markRead]);

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

  const activeCall = useGroupCall(groupId);
  const openCall = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    router.push({ pathname: '/call/[groupId]', params: { groupId: String(groupId), name: title } });
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

  // ---- Header + apps -------------------------------------------------------------------------
  const group = t.group;
  const isDm = !!group?.is_dm;
  const title = group?.name ?? params.name ?? '';
  const others = useMemo(
    () => (members ?? []).filter((mem) => mem.user.id !== me.id).map((mem) => mem.user),
    [members, me.id],
  );
  const headerAvatar = group?.avatar_url ?? (isDm ? (others[0]?.avatar_url ?? null) : null);
  const memberAvatars = others.slice(0, 2).map((u) => u.avatar_url);
  // iMessage's "‹ 12": unread threads other than this one.
  const unreadHere = inbox.items.find((it) => it.group.id === groupId)?.unread_count ?? 0;
  const unreadElsewhere = Math.max(0, inbox.unreadThreads - (unreadHere > 0 ? 1 : 0));

  const lastIncoming = useMemo(
    () => [...t.messages].reverse().find((m) => m.id > 0 && m.kind !== 'system' && m.sender_id !== me.id),
    [t.messages, me.id],
  );
  const openGroupInfo = () => {
    Haptics.selectionAsync();
    router.push({ pathname: '/group/[id]', params: { id: String(groupId), name: title } });
  };
  const openLore = () => router.push({ pathname: '/reels', params: { group: String(groupId) } });

  const headerHeight = insets.top + 2 + HEADER_ROW;

  const renderItem = ({ item }: { item: Item }) => {
    switch (item.type) {
      case 'sep':
        return <TimeSeparator ts={item.ts} />;
      case 'system':
        return <SystemLine text={item.m.text} names={names} />;
      case 'seen':
        return <SeenBy users={item.users} isDm={isDm} readAt={item.readAt} delivered={item.delivered} />;
      case 'lore':
        return <LoreSuggestionCard lore={item.lore} onKeep={() => keepLore(item.lore)} onDismiss={() => dismissLore(item.lore)} />;
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
            avatars={!isDm}
            run={item.run}
            meId={me.id}
            highlighted={highlightId === m.id}
            replied={
              m.reply_to
                ? {
                    name: replied?.sender_id === me.id ? 'you' : repliedSender ? firstName(repliedSender.display_name) : 'a message',
                    text: replied ? (replied.kind === 'photo' ? 'Photo' : replied.text) : 'Original message',
                  }
                : null
            }
            userById={userById}
            onReact={onReact}
            onReply={onReply}
            onCopy={onCopy}
            onExplain={explainMessage}
            onSaveToLore={m.id > 0 ? saveToLore : undefined}
            onOpenPhoto={setViewing}
            kept={m.kind === 'photo' && keptPhotoIds.has(m.id)}
          />
        );
      }
    }
  };

  const intro = group ? (
    <View style={[styles.intro, { paddingTop: headerHeight + (pillVisible ? 60 : 24) + (activeCall && !isPreview ? 56 : 0) }]}>
      {isDm || group.avatar_url ? (
        <Avatar uri={headerAvatar} name={title} size={92} />
      ) : (
        <GroupAvatar uris={memberAvatars} size={92} />
      )}
      <Text style={styles.introTitle}>{group.name}</Text>
      <Text style={styles.introSub}>{isDm ? 'iMessage' : `${group.member_count} people`}</Text>
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
            <Text style={styles.errorText}>
              Couldn’t load this chat.{'\n'}
              {t.error}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={items}
            inverted
            // A peek renders inside the inbox's ScrollView; it doesn't scroll, and a scrollable list
            // there trips React Native's nested-VirtualizedList error.
            scrollEnabled={!isPreview}
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
        {isPreview ? null : awayFromBottom || t.hasMoreAfter ? (
          <View style={styles.fab}>
            <GlassCircle size={38} onPress={jumpToLatest} accessibilityLabel="Jump to latest">
              <Icon name="chevron.down" size={15} weight="semibold" color={colors.blue} />
            </GlassCircle>
          </View>
        ) : null}
        {isPreview ? null : (
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
              sendLabel={attachment ? 'Send' : nudge.sendLabel}
              sending={!attachment && nudge.checkingUnknown}
              onSend={attachment ? sendPhotoNow : nudge.send}
              placeholder={isDm ? 'iMessage' : 'Message'}
              reply={
                replyTo
                  ? {
                      name: replyTo.sender_id === me.id ? 'You' : firstName(userById(replyTo.sender_id)?.display_name ?? ''),
                      text: replyTo.text,
                      photoUri: replyTo.kind === 'photo' ? (replyTo.image?.url ?? null) : null,
                    }
                  : null
              }
              onCancelReply={() => setReplyTo(null)}
              attachment={attachment}
              onRemoveAttachment={() => setAttachment(null)}
              apps={{
                onPhotos: pickPhoto,
                onCamera: takePhoto,
                onCatchup: catchup || unreadHere > 0 ? openCatchup : undefined,
                onExplain: lastIncoming ? () => explainMessage(lastIncoming) : undefined,
                onLore: openLore,
                onCall: openCall,
              }}
            />
          </View>
        )}
      </KeyboardAvoidingView>
      <ThreadHeader
        title={title}
        avatarUrl={headerAvatar}
        memberAvatars={memberAvatars}
        isGroup={!!group && !isDm}
        unreadCount={unreadElsewhere}
        onBack={() => router.back()}
        onOpenInfo={openGroupInfo}
        onVideo={openCall}
        onAudio={openCall}
      />
      {activeCall && !isPreview ? <CallBar call={activeCall} top={headerHeight + 6} meId={me.id} onJoin={openCall} /> : null}
      {catchup ? <CatchupPill count={catchup.count} top={headerHeight + (activeCall ? 62 : 6)} onPress={openCatchup} /> : null}
      <PhotoViewer
        message={viewing}
        onClose={() => setViewing(null)}
        kept={!!viewing && keptPhotoIds.has(viewing.id)}
        onSaveToLore={viewing && viewing.id > 0 ? saveToLore : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 },
  errorText: { color: colors.textSecondary, textAlign: 'center', fontSize: 15 },
  intro: { alignItems: 'center', paddingBottom: 24, gap: 6 },
  introTitle: { color: colors.text, fontSize: 20, fontWeight: '700', marginTop: 8 },
  introSub: { color: colors.textSecondary, fontSize: 14 },
  fab: { position: 'absolute', right: 14, bottom: 120 },
});
