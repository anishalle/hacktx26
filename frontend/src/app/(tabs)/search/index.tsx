import { ContentUnavailableView, Host } from '@expo/ui/swift-ui';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { api, type GlossaryEntry, type Lore } from '@/api';
import { Icon } from '@/components/Icon';
import { InboxRow } from '@/components/inbox/InboxRow';
import { LoreThumb } from '@/components/lore/MomentRow';
import { filterConversations, useGroupMembers } from '@/lib/conversations';
import { loreSubtitle } from '@/lib/lore';
import { useInbox } from '@/state/inbox';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

type Term = GlossaryEntry & { group_name: string };

const MAX_TERMS = 8;

/** Terms whose name or alias matches come first, then ones whose meaning does. */
function matchTerms(terms: Term[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const named = terms.filter((t) => [t.term, ...t.aliases].some((a) => a.toLowerCase().includes(needle)));
  const meant = terms.filter((t) => !named.includes(t) && t.meaning.toLowerCase().includes(needle));
  return [...named, ...meant].slice(0, MAX_TERMS);
}

/** The search tab: conversations, Lore titles and each group's inside terms in one place. */
export default function SearchScreen() {
  const router = useRouter();
  const me = useMe();
  const { items } = useInbox();
  const { userById } = useSession();
  const members = useGroupMembers(items, me.id);
  const [query, setQuery] = useState('');
  const q = query.trim();
  const [lore, setLore] = useState<{ q: string; items: Lore[] } | null>(null);
  const [pinned, setPinned] = useState<Lore[]>([]);

  // Glossaries are per group; fetch each group's once the inbox is known.
  const groupKey = useMemo(
    () =>
      items
        .filter((i) => !i.group.is_dm)
        .map((i) => i.group.id)
        .join(','),
    [items],
  );
  const [glossary, setGlossary] = useState<GlossaryEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    const ids = groupKey ? groupKey.split(',').map(Number) : [];
    Promise.all(ids.map((id) => api.getGlossary(id).catch(() => [] as GlossaryEntry[]))).then(
      (lists) => !cancelled && setGlossary(lists.flat()),
    );
    return () => {
      cancelled = true;
    };
  }, [groupKey]);
  const terms = useMemo<Term[]>(() => {
    const names = new Map(items.map((i) => [i.group.id, i.group.name]));
    return glossary.map((t) => ({ ...t, group_name: names.get(t.group_id) ?? '' }));
  }, [glossary, items]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      api
        .getLoreFeed(me.id, { pinned: true, limit: 6 })
        .then((feed) => !cancelled && setPinned(feed.items))
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    }, [me.id]),
  );

  // Lore matches on title server-side; debounce so typing doesn't fire a request per key.
  useEffect(() => {
    if (!q) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .getLoreFeed(me.id, { q, sort: 'recent', limit: 8 })
        .then((feed) => !cancelled && setLore({ q, items: feed.items }))
        .catch(() => !cancelled && setLore({ q, items: [] }));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q, me.id]);

  const conversations = useMemo(
    () => (q ? filterConversations(items, q, 'All', members) : items.slice(0, 4)),
    [items, q, members],
  );
  const loreResults = q ? (lore?.q === q ? lore.items : null) : pinned;
  const termResults = useMemo(() => matchTerms(terms, q), [terms, q]);
  const nothing = !conversations.length && !termResults.length && loreResults !== null && !loreResults.length;

  const openLore = (l: Lore) => router.push({ pathname: '/lore/[id]', params: { id: String(l.id) } });
  const openTerm = (t: Term) =>
    router.push({ pathname: '/explain', params: { groupId: String(t.group_id), term: t.term } });

  return (
    <>
      <Stack.Title large>Search</Stack.Title>
      <Stack.SearchBar
        placeholder="Messages, Lore, inside jokes"
        autoFocus
        onChangeText={(e) => setQuery(e.nativeEvent.text)}
        onCancelButtonPress={() => setQuery('')}
      />
      <ScrollView
        style={styles.screen}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.content}
      >
        {conversations.length ? (
          <Section title={q ? 'Conversations' : 'Recent'}>
            {conversations.map((item, i) => (
              <InboxRow
                key={item.group.id}
                item={item}
                meId={me.id}
                userById={userById}
                members={members[item.group.id]}
                last={i === conversations.length - 1}
              />
            ))}
          </Section>
        ) : null}
        {loreResults === null ? (
          <Section title="Lore">
            <ActivityIndicator style={styles.loading} color={colors.textSecondary} />
          </Section>
        ) : loreResults.length ? (
          <Section title={q ? 'Lore' : 'Pinned Moments'}>
            {loreResults.map((l, i) => (
              <LoreRow key={l.id} lore={l} last={i === loreResults.length - 1} onPress={() => openLore(l)} />
            ))}
          </Section>
        ) : null}
        {termResults.length ? (
          <Section title="Inside Terms">
            {termResults.map((t, i) => (
              <TermRow key={t.id} term={t} last={i === termResults.length - 1} onPress={() => openTerm(t)} />
            ))}
          </Section>
        ) : null}
        {nothing ? (
          <Host matchContents={{ vertical: true }} style={styles.empty}>
            {q ? (
              <ContentUnavailableView
                title={`No Results for “${q}”`}
                systemImage="magnifyingglass"
                description="Check the spelling or try a new search."
              />
            ) : (
              <ContentUnavailableView
                title="Search Closer"
                systemImage="magnifyingglass"
                description="Find conversations, Lore and the words your groups use."
              />
            )}
          </Host>
        ) : null}
      </ScrollView>
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

function LoreRow({ lore, last, onPress }: { lore: Lore; last: boolean; onPress: () => void }) {
  const subtitle = loreSubtitle(lore, { weekday: false, people: false });
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${lore.title}, ${subtitle}${lore.pinned ? ', pinned' : ''}`}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.thumbSlot}>
        <LoreThumb lore={lore} size={48} radius={10} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {lore.title}
        </Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      {lore.pinned ? <Icon name="pin.fill" size={13} color={colors.textTertiary} /> : null}
      <Icon name="chevron.forward" size={13} color={colors.textTertiary} weight="semibold" />
      {last ? null : <View style={styles.separator} />}
    </Pressable>
  );
}

function TermRow({ term, last, onPress }: { term: Term; last: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${term.term}, ${term.group_name}. ${term.meaning}`}
      accessibilityHint="Explains this term"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={[styles.thumb, { backgroundColor: colors.accentSoft }]}>
        <Icon name="text.quote" size={20} color={colors.blue} />
      </View>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {term.term}
        </Text>
        <Text style={styles.rowSub} numberOfLines={2}>
          {term.group_name} · {term.meaning}
        </Text>
      </View>
      <Icon name="chevron.forward" size={13} color={colors.textTertiary} weight="semibold" />
      {last ? null : <View style={styles.separator} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingBottom: 24 },
  section: { marginTop: 16 },
  sectionTitle: { color: colors.text, fontSize: 22, fontWeight: '700', paddingHorizontal: 20, marginBottom: 4 },
  row: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingLeft: 20, paddingRight: 16, gap: 8 },
  pressed: { backgroundColor: 'rgba(0,0,0,0.05)' },
  thumb: {
    width: 48,
    height: 48,
    borderRadius: 10,
    borderCurve: 'continuous',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 4,
  },
  thumbSlot: { marginRight: 4 },
  rowBody: { flex: 1, paddingVertical: 10, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 17, fontWeight: '600' },
  rowSub: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  separator: {
    position: 'absolute',
    left: 80,
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.separator,
  },
  loading: { marginVertical: 20 },
  empty: { width: '100%', marginTop: 48 },
});
