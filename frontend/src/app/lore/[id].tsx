import { Button, ConfirmationDialog, ContentUnavailableView, Host, Text as SwiftText } from '@expo/ui/swift-ui';
import { buttonStyle, controlSize } from '@expo/ui/swift-ui/modifiers';
import { Image } from 'expo-image';
import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { api, type Lore, type LoreDetail, type Message } from '@/api';
import { Avatar } from '@/components/Avatar';
import { AudioTile } from '@/components/lore/AudioTile';
import { clockLabel, EventBlock } from '@/components/lore/EventBlock';
import { QuoteBubble, useLoreActions } from '@/components/lore/MomentCard';
import { heroPhoto, MomentRow } from '@/components/lore/MomentRow';
import { PhotoViewer } from '@/components/thread/PhotoViewer';
import { useExplain } from '@/features/explain';
import { firstName } from '@/lib/format';
import { loreDate } from '@/lib/lore';
import type { PlaybackItem } from '@/state/playback';
import { useRealtime } from '@/state/realtime';
import { useMe } from '@/state/session';
import { colors } from '@/theme';

/**
 * One moment: the hero (the zoom target from the deck), who/when, the serif title, its inside
 * terms, then a timeline of what was actually sent and said, and more from the group.
 */
export default function MomentScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const me = useMe();
  const router = useRouter();
  const onExplain = useExplain();
  const { width } = useWindowDimensions();
  const [lore, setLore] = useState<LoreDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getLore(Number(id), me.id)
      .then((d) => !cancelled && setLore(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [id, me.id]);

  const leave = useCallback(() => {
    if (router.canGoBack()) router.back();
  }, [router]);

  // Only `pinned` changes from here; the detail keeps its full events.
  const onChange = useCallback(
    (lid: number, p: Partial<Lore>) => setLore((l) => (l && l.id === lid ? { ...l, pinned: p.pinned ?? l.pinned } : l)),
    [],
  );
  const actions = useLoreActions({ onChange, onRemoved: leave });

  // Pins from another device update here; a removal elsewhere closes the page.
  useRealtime((frame) => {
    if (frame.type !== 'lore.updated' || frame.data.id !== Number(id)) return;
    if (frame.data.status !== 'kept') leave();
    else setLore((l) => (l ? { ...l, pinned: frame.data.pinned, title: frame.data.title } : l));
  });

  const queue = useMemo<PlaybackItem[]>(
    () => (lore ? lore.events.flatMap((e) => (e.replay ? [{ lore, replay: e.replay }] : [])) : []),
    [lore],
  );

  // Hero first in `events`; the timeline reads oldest first.
  const timeline = useMemo(
    () => (lore ? lore.events.map((event, i) => ({ event, hero: i === 0 })).sort((a, b) => a.event.at.localeCompare(b.event.at)) : []),
    [lore],
  );

  const header = (
    <>
      <Stack.Screen options={{ headerShown: true, headerTransparent: true, headerBackTitle: 'Lore', title: '' }} />
      {lore ? (
        <Stack.Toolbar placement="right">
          <Stack.Toolbar.Button
            icon={lore.pinned ? 'pin.fill' : 'pin'}
            accessibilityLabel={lore.pinned ? 'Unpin' : 'Pin'}
            onPress={() => actions.togglePin(lore)}
          />
          <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel="More">
            <Stack.Toolbar.MenuAction icon="square.and.arrow.up" onPress={() => actions.share(lore)}>
              Share
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="bubble.left.and.bubble.right" onPress={() => actions.openInChat(lore)}>
              Open in Chat
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="trash" destructive onPress={() => setConfirming(true)}>
              Remove from Lore
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
        </Stack.Toolbar>
      ) : null}
    </>
  );

  if (!lore) {
    return (
      <View style={styles.screen}>
        {header}
        {error ? (
          <Host matchContents={{ vertical: true }} style={styles.state}>
            <ContentUnavailableView title="Can’t Load This Moment" systemImage="exclamationmark.triangle" description={error} />
          </Host>
        ) : (
          <ActivityIndicator style={styles.state} color={colors.textSecondary} />
        )}
      </View>
    );
  }

  const photo = heroPhoto(lore);
  const replay = queue[0]?.replay ?? lore.cover.replay;
  const heroEvent = lore.events[0];
  const heroW = width - 32;
  const aspect = photo?.image && photo.image.width > 0 && photo.image.height > 0 ? photo.image.width / photo.image.height : 4 / 3;
  // Full width, between 3:4 portrait and 16:9 landscape.
  const heroH = heroW / Math.min(16 / 9, Math.max(3 / 4, aspect));

  let hero = null;
  if (lore.hero_kind === 'photo' && photo?.image) {
    hero = (
      <Pressable onPress={() => setViewing(photo)} accessibilityRole="imagebutton" accessibilityLabel={photo.image_description ?? 'Photo'}>
        <Image source={{ uri: photo.image.url }} style={[styles.heroPhoto, { width: heroW, height: heroH }]} contentFit="cover" transition={200} />
      </Pressable>
    );
  } else if (lore.hero_kind === 'replay' && replay) {
    hero = (
      <View style={{ width: heroW }}>
        <AudioTile lore={lore} replay={replay} queue={queue} size="large" />
      </View>
    );
  } else if (heroEvent?.message) {
    hero = (
      <View style={{ width: heroW }}>
        <QuoteBubble message={heroEvent.message} large />
      </View>
    );
  }

  const when = [lore.group_name, `${loreDate(lore.started_at, { weekday: false })}, ${clockLabel(lore.started_at)}`, lore.source === 'call' ? 'from a call' : '']
    .filter(Boolean)
    .join(' · ');
  const keptBy = lore.kept_by ? (lore.kept_by.id === me.id ? 'You' : firstName(lore.kept_by.display_name)) : null;
  const sameGroup = lore.related.length > 0 && lore.related.every((r) => r.group_id === lore.group_id);

  return (
    <View style={styles.screen}>
      {header}
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {hero ? (
          <View style={styles.hero}>
            {/* The zoom target needs one non-collapsable native child, or it hides the hero. */}
            <Link.AppleZoomTarget>
              <View collapsable={false}>{hero}</View>
            </Link.AppleZoomTarget>
          </View>
        ) : null}

        <View style={styles.kicker}>
          {lore.people.length ? (
            <View style={styles.faces}>
              {lore.people.slice(0, 4).map((p, i) => (
                <Avatar key={p.id} uri={p.avatar_url} name={p.display_name} size={26} ring={colors.bg} style={i ? styles.faceOverlap : null} />
              ))}
            </View>
          ) : null}
          <View style={styles.kickerText}>
            <Text style={styles.when} numberOfLines={2}>
              {when}
            </Text>
            {keptBy ? <Text style={styles.when}>Kept by {keptBy}</Text> : null}
          </View>
        </View>

        <Text style={styles.title}>{lore.title}</Text>

        {lore.terms.length ? (
          <View style={styles.terms}>
            {lore.terms.map((t) => (
              <Pressable
                key={t.term}
                onPress={() => onExplain({ groupId: lore.group_id, term: t.term })}
                style={({ pressed }) => [styles.term, pressed && styles.termPressed]}
                accessibilityRole="button"
                accessibilityLabel={`Explain ${t.term}`}
              >
                <Text style={styles.termText}>{t.term}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        <View style={styles.timeline}>
          {timeline.map(({ event, hero: isHero }, i) => (
            <EventBlock key={`${event.kind}:${event.at}:${i}`} lore={lore} event={event} showAnchor={!isHero} onOpenPhoto={setViewing} queue={queue} />
          ))}
        </View>

        {lore.related.length ? (
          <View style={styles.related}>
            <Text style={styles.relatedTitle}>{sameGroup ? `More from ${lore.group_name}` : 'More Lore'}</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.relatedRow}>
              {lore.related.map((r) => (
                <MomentRow key={r.id} lore={r} variant="card" />
              ))}
            </ScrollView>
          </View>
        ) : null}

        <Host matchContents style={styles.remove}>
          <ConfirmationDialog
            title={`Remove “${lore.title}” from Lore?`}
            titleVisibility="visible"
            isPresented={confirming}
            onIsPresentedChange={setConfirming}
          >
            <ConfirmationDialog.Trigger>
              <Button
                label="Remove from Lore"
                role="destructive"
                onPress={() => setConfirming(true)}
                modifiers={[buttonStyle('borderless'), controlSize('regular')]}
              />
            </ConfirmationDialog.Trigger>
            <ConfirmationDialog.Actions>
              <Button label="Remove from Lore" role="destructive" onPress={() => actions.remove(lore)} />
              <Button label="Cancel" role="cancel" />
            </ConfirmationDialog.Actions>
            <ConfirmationDialog.Message>
              <SwiftText>It leaves {lore.group_name}’s Lore for everyone.</SwiftText>
            </ConfirmationDialog.Message>
          </ConfirmationDialog>
        </Host>
      </ScrollView>
      <PhotoViewer message={viewing} onClose={() => setViewing(null)} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  state: { marginTop: 140, alignSelf: 'center' },
  content: { paddingBottom: 48 },
  hero: { paddingHorizontal: 16, paddingTop: 8 },
  heroPhoto: { borderRadius: 22, borderCurve: 'continuous', backgroundColor: colors.surfaceAlt },
  kicker: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, marginTop: 18 },
  faces: { flexDirection: 'row' },
  faceOverlap: { marginLeft: -8 },
  kickerText: { flex: 1, minWidth: 0 },
  when: { color: colors.textSecondary, fontSize: 13, lineHeight: 18 },
  title: {
    color: colors.text,
    fontFamily: 'ui-serif',
    fontSize: 30,
    fontWeight: '700',
    lineHeight: 36,
    paddingHorizontal: 16,
    marginTop: 8,
  },
  terms: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginTop: 14 },
  term: {
    backgroundColor: colors.accentSoft,
    borderRadius: 16,
    paddingHorizontal: 14,
    minHeight: 32,
    justifyContent: 'center',
  },
  termPressed: { opacity: 0.6 },
  termText: { color: colors.blue, fontSize: 15, fontWeight: '600' },
  timeline: { marginTop: 26, gap: 26 },
  related: { marginTop: 34, gap: 12 },
  relatedTitle: { color: colors.text, fontSize: 22, fontWeight: '700', paddingHorizontal: 16 },
  relatedRow: { gap: 12, paddingHorizontal: 16 },
  remove: { alignSelf: 'center', marginTop: 34 },
});
