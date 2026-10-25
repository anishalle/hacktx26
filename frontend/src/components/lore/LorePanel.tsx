import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
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
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
                  {detail.related.map((r) => (
                    <Pressable
                      key={r.id}
                      onPress={() => {
                        Haptics.selectionAsync();
                        router.push({ pathname: '/lore/[id]', params: { id: String(r.id) } });
                      }}
                      style={({ pressed }) => [styles.related, pressed && { opacity: 0.7 }]}>
                      {r.cover.photo?.image ? (
                        <Image source={{ uri: r.cover.photo.image.url }} style={styles.relatedImg} contentFit="cover" />
                      ) : (
                        <View style={[styles.relatedImg, styles.relatedText]}>
                          <Icon name={r.cover.replay ? 'waveform' : 'sparkles'} size={20} color={colors.sparkle} />
                        </View>
                      )}
                      <Text style={styles.relatedTitle} numberOfLines={2}>
                        {r.title}
                      </Text>
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
      <PhotoViewer message={viewing} onClose={() => setViewing(null)} />
    </View>
  );
}

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
  related: { width: 150 },
  relatedImg: { width: 150, height: 190, borderRadius: 14, backgroundColor: colors.surface },
  relatedText: { alignItems: 'center', justifyContent: 'center' },
  relatedTitle: { color: colors.text, fontSize: 13, fontWeight: '600', marginTop: 6 },
  remove: { marginTop: 36, alignSelf: 'center', paddingVertical: 10, paddingHorizontal: 18 },
  removeText: { color: '#FF6B6B', fontSize: 15, fontWeight: '600' },
});
