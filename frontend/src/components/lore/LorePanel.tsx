import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { api, type Lore, type LoreDetail, type Message } from '@/api';
import { Avatar } from '@/components/Avatar';
import { Icon } from '@/components/Icon';
import { PhotoViewer } from '@/components/thread/PhotoViewer';
import { useExplain } from '@/features/explain';
import { firstName, separatorLabel } from '@/lib/format';
import { useMe, useSession } from '@/state/session';
import { colors } from '@/theme';

import { ReplayPlayer } from './ReplayPlayer';

type Props = {
  lore: Lore;
  /** Load the detail only once the panel is opened. */
  open: boolean;
  onRemoved: (id: number) => void;
};

/** Swipe left on a lore card: the moment's story and every piece of evidence, plus related lore. */
export function LorePanel({ lore, open, onRemoved }: Props) {
  const me = useMe();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { userById } = useSession();
  const onExplain = useExplain();
  const [detail, setDetail] = useState<LoreDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Message | null>(null);

  useEffect(() => {
    if (!open || detail) return;
    let cancelled = false;
    api
      .getLore(lore.id, me.id)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [open, detail, lore.id, me.id]);

  const openThread = (m: Message) => {
    Haptics.selectionAsync();
    router.push({ pathname: '/thread/[id]', params: { id: String(lore.group_id), around: String(m.id), name: lore.group_name } });
  };

  const remove = () =>
    Alert.alert('Remove from Lore?', `“${lore.title}” leaves the group’s Lore for everyone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          try {
            await api.removeLore(lore.id, me.id);
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            onRemoved(lore.id);
          } catch (e) {
            Alert.alert('Couldn’t remove it', e instanceof Error ? e.message : String(e));
          }
        },
      },
    ]);

  return (
    <View style={styles.panel}>
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 110 }]}>
        <Text style={styles.kicker}>
          {lore.group_name} · {separatorLabel(lore.started_at)}
        </Text>
        <Text style={styles.title}>{lore.title}</Text>
        <Text style={styles.story}>{lore.story}</Text>

        {lore.terms.length ? (
          <View style={styles.chips}>
            {lore.terms.map((t) => (
              <Pressable
                key={t.term}
                onPress={() => onExplain({ groupId: lore.group_id, term: t.term })}
                style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}>
                <Text style={styles.chipText}>{t.term}</Text>
                <Icon name="questionmark.circle" size={13} color={colors.sparkle} />
              </Pressable>
            ))}
          </View>
        ) : null}

        {!detail ? (
          <View style={styles.loading}>{error ? <Text style={styles.error}>{error}</Text> : <ActivityIndicator color={colors.textSecondary} />}</View>
        ) : (
          <>
            {detail.replays.length ? (
              <Section icon="waveform" title="Replays">
                {detail.replays.map((r) => (
                  <View key={r.id} style={styles.replay}>
                    <ReplayPlayer replay={r} active={open} compact />
                  </View>
                ))}
              </Section>
            ) : null}

            {detail.photos.length ? (
              <Section icon="photo.on.rectangle" title="Photos">
                <View style={styles.grid}>
                  {detail.photos.map((p) =>
                    p.image ? (
                      <Pressable key={p.id} onPress={() => setViewing(p)} style={styles.gridCell}>
                        <Image source={{ uri: p.image.url }} style={StyleSheet.absoluteFill} contentFit="cover" />
                      </Pressable>
                    ) : null,
                  )}
                </View>
              </Section>
            ) : null}

            {detail.messages.length ? (
              <Section icon="bubble.left.and.bubble.right" title="What was said">
                {detail.messages.map((m) => {
                  const who = m.sender_id ? userById(m.sender_id) : undefined;
                  return (
                    <Pressable key={m.id} onPress={() => openThread(m)} style={({ pressed }) => [styles.msg, pressed && styles.pressed]}>
                      <Avatar uri={who?.avatar_url} size={28} />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.msgName}>{who ? firstName(who.display_name) : 'Someone'}</Text>
                        {m.kind === 'photo' && m.image ? (
                          <Image source={{ uri: m.image.url }} style={styles.msgPhoto} contentFit="cover" />
                        ) : null}
                        {m.text ? <Text style={styles.msgText}>{m.text}</Text> : null}
                      </View>
                      <Icon name="arrow.up.forward" size={12} color={colors.textTertiary} style={{ marginTop: 4 }} />
                    </Pressable>
                  );
                })}
              </Section>
            ) : null}

            {detail.related.length ? (
              <Section icon="sparkles" title="More lore like this">
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.relatedRow} contentContainerStyle={styles.relatedRowContent}>
                  {detail.related.map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => {
                        Haptics.selectionAsync();
                        router.push({ pathname: '/lore/[id]', params: { id: String(r.id) } });
                      }}
                      style={({ pressed }) => [styles.related, pressed && { opacity: 0.7 }]}>
                      {r.cover.photo?.image ? (
                        <>
                          <Image source={{ uri: r.cover.photo.image.url }} style={StyleSheet.absoluteFill} contentFit="cover" />
                          <LinearGradient colors={['rgba(0,0,0,0)', 'rgba(0,0,0,0.85)']} locations={[0.35, 1]} style={StyleSheet.absoluteFill} />
                        </>
                      ) : (
                        <LinearGradient colors={COVERS[r.id % COVERS.length]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill}>
                          <View style={styles.relatedTop}>
                            <Icon name={r.cover.replay ? 'waveform' : 'quote.opening'} size={16} color="rgba(255,255,255,0.6)" />
                            <Text style={styles.relatedStory} numberOfLines={4}>
                              {r.story}
                            </Text>
                          </View>
                        </LinearGradient>
                      )}
                      <View style={styles.relatedMeta}>
                        <Text style={styles.relatedTitle} numberOfLines={3}>
                          {r.title}
                        </Text>
                        <Text style={styles.relatedWhen}>{separatorLabel(r.started_at)}</Text>
                      </View>
                    </Pressable>
                  ))}
                </ScrollView>
              </Section>
            ) : null}
          </>
        )}

        <Pressable onPress={remove} style={({ pressed }) => [styles.remove, pressed && { opacity: 0.6 }]}>
          <Text style={styles.removeText}>Remove from Lore</Text>
        </Pressable>
      </ScrollView>
      {/* Content scrolls under the status bar: keep a solid strip there. */}
      <LinearGradient
        colors={['#0B0B0D', '#0B0B0D', 'rgba(11,11,13,0)']}
        locations={[0, 0.7, 1]}
        style={[styles.statusScrim, { height: insets.top + 14 }]}
        pointerEvents="none"
      />
      <PhotoViewer message={viewing} onClose={() => setViewing(null)} />
    </View>
  );
}

/** Covers for lore without a photo, picked by id so a card keeps its color. */
const COVERS = [
  ['#3A1C71', '#1B2A5C'],
  ['#5B2A86', '#B33F62'],
  ['#0F4C75', '#3282B8'],
  ['#1E5631', '#2F855A'],
  ['#7B3F00', '#C05621'],
] as const;

function Section({ icon, title, children }: { icon: 'waveform' | 'photo.on.rectangle' | 'bubble.left.and.bubble.right' | 'sparkles'; title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Icon name={icon} size={14} color={colors.textSecondary} />
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: '#0B0B0D' },
  content: { paddingHorizontal: 20 },
  kicker: { color: colors.textSecondary, fontSize: 13, fontWeight: '600' },
  title: { color: colors.text, fontSize: 26, fontWeight: '800', letterSpacing: -0.4, marginTop: 6 },
  story: { color: colors.text, fontSize: 16, lineHeight: 23, marginTop: 10, opacity: 0.9 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 14 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(124, 92, 255, 0.16)',
    borderWidth: 1,
    borderColor: 'rgba(160, 130, 255, 0.35)',
  },
  chipText: { color: colors.text, fontSize: 14, fontWeight: '600' },
  loading: { paddingVertical: 40, alignItems: 'center' },
  error: { color: '#FF6B6B', fontSize: 14 },
  section: { marginTop: 28 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 10 },
  sectionTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.4 },
  replay: { backgroundColor: colors.surfaceAlt, borderRadius: 18, padding: 14, marginBottom: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 4 },
  gridCell: { width: '32.6%', aspectRatio: 1, borderRadius: 8, overflow: 'hidden', backgroundColor: colors.surface },
  msg: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 8, paddingHorizontal: 4, borderRadius: 12 },
  pressed: { backgroundColor: 'rgba(255,255,255,0.06)' },
  msgName: { color: colors.textSecondary, fontSize: 12, fontWeight: '600', marginBottom: 2 },
  msgText: { color: colors.text, fontSize: 15, lineHeight: 20 },
  msgPhoto: { width: 140, height: 100, borderRadius: 10, marginVertical: 4 },
  statusScrim: { position: 'absolute', top: 0, left: 0, right: 0 },
  relatedRow: { marginHorizontal: -20 },
  relatedRowContent: { gap: 10, paddingHorizontal: 20 },
  related: { width: 150, height: 200, borderRadius: 14, overflow: 'hidden', backgroundColor: colors.surface, justifyContent: 'flex-end' },
  relatedTop: { padding: 12, gap: 6 },
  relatedStory: { color: 'rgba(255,255,255,0.82)', fontSize: 12, lineHeight: 16 },
  relatedMeta: { padding: 10, gap: 2 },
  relatedTitle: { color: 'white', fontSize: 14, fontWeight: '700', lineHeight: 18 },
  relatedWhen: { color: 'rgba(255,255,255,0.65)', fontSize: 11 },
  remove: { marginTop: 36, alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 18 },
  removeText: { color: '#FF6B6B', fontSize: 15, fontWeight: '600' },
});
