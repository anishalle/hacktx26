import { StyleSheet, Text, View } from 'react-native';
import type { Participant } from '../../types/call';
import { ChimeVideo } from '../../services/chime';

interface VideoGridProps {
  participants: Participant[];
  activeSpeakerId: string | null;
}

/**
 * Grid of participant video tiles (2-4 participants).
 * Highlights the active speaker with a colored border.
 * Placeholder tiles for now — will integrate with Daily/LiveKit video tracks later.
 */
export function VideoGrid({ participants, activeSpeakerId }: VideoGridProps) {
  const tileCount = participants.length;
  const isGrid = tileCount > 2;

  return (
    <View style={[styles.grid, isGrid && styles.gridWrap]}>
      {participants.map((p) => (
        <View
          key={p.id}
          style={[
            styles.tile,
            isGrid ? styles.tileHalf : styles.tileFull,
            activeSpeakerId === p.id && styles.tileSpeaking,
          ]}
        >
          {p.videoTileId !== undefined ? (
            <ChimeVideo tileId={p.videoTileId} mirror={p.isLocal} style={StyleSheet.absoluteFill} />
          ) : <View style={styles.avatarPlaceholder}>
            <Text style={styles.avatarInitial}>
              {p.displayName.charAt(0).toUpperCase()}
            </Text>
          </View>}

          {p.videoTileId === undefined && <Text style={{ color: '#7f8996', fontSize: 12, marginTop: 18 }}>Camera off</Text>}
          <View style={styles.nameTag}>
            <Text style={styles.nameText} numberOfLines={1}>
              {p.displayName}
              {p.isLocal ? ' (You)' : ''}
            </Text>
            {p.isMuted && <Text style={styles.mutedIcon}>Muted</Text>}
          </View>

          {activeSpeakerId === p.id && (
            <View style={styles.speakingIndicator}>
              <View style={styles.speakingDot} />
              <View style={[styles.speakingDot, styles.speakingDotDelay1]} />
              <View style={[styles.speakingDot, styles.speakingDotDelay2]} />
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flex: 1,
    flexDirection: 'column',
    gap: 10,
    paddingHorizontal: 16,
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  tile: {
    backgroundColor: '#202329',
    borderRadius: 28,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    borderWidth: 2,
    borderColor: 'transparent',
  },
  tileFull: {
    flex: 1,
  },
  tileHalf: {
    width: '48.5%',
    height: '48.5%',
    flexGrow: 1,
    margin: '0.5%',
  },
  tileSpeaking: {
    borderColor: '#8ec6ff',
    borderWidth: 3,
  },
  avatarPlaceholder: {
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: '#303a47',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarInitial: {
    fontSize: 28,
    fontWeight: '700',
    color: '#d2e3f7',
  },
  nameTag: {
    position: 'absolute',
    bottom: 12,
    left: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  nameText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  mutedIcon: {
    marginLeft: 6,
    fontSize: 12,
  },
  speakingIndicator: {
    position: 'absolute',
    top: 12,
    right: 12,
    flexDirection: 'row',
    gap: 3,
  },
  speakingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#8ec6ff',
    opacity: 0.8,
  },
  speakingDotDelay1: {
    opacity: 0.6,
  },
  speakingDotDelay2: {
    opacity: 0.4,
  },
});
