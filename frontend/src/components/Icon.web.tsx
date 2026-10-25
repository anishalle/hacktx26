import type { SymbolViewProps } from 'expo-symbols';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { colors } from '@/theme';

// Small outline equivalents for SF Symbols in the mobile browser.
const paths: Record<string, string> = {
  video: 'M3 6h12v12H3z M15 10l6-4v12l-6-4',
  'video.fill': 'M3 6h12v12H3z M15 10l6-4v12l-6-4',
  'video.slash.fill': 'M3 6h12v12H3z M15 10l6-4v12l-6-4 M2 2l20 20',
  'square.grid.2x2': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  'square.grid.2x2.fill': 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  'bubble.left.and.bubble.right': 'M3 4h14v11H8l-5 4z M17 9h4v12l-5-3h-5v-3',
  'chevron.left': 'M15 5l-7 7 7 7',
  'chevron.right': 'M9 5l7 7-7 7',
  'chevron.down': 'M5 9l7 7 7-7',
  'chevron.up': 'M5 15l7-7 7 7',
  xmark: 'M6 6l12 12 M18 6L6 18',
  plus: 'M12 4v16 M4 12h16',
  questionmark: 'M8 8a4 4 0 1 1 6 3.5c-2 1-2 1-2 3 M12 19h.01',
  'questionmark.circle': 'M8 8a4 4 0 1 1 6 3.5c-2 1-2 1-2 3 M12 19h.01',
  magnifyingglass: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14 M15 15l6 6',
  'person.crop.circle': 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6 M5 19c0-7 14-7 14 0',
  'person.fill': 'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M4 21v-3c0-7 16-7 16 0v3',
  photo: 'M3 3h18v18H3z M3 17l6-6 5 5 3-3 4 4 M16 7h.01',
  'mic.fill': 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M6 10v2a6 6 0 0 0 12 0v-2 M12 18v4 M8 22h8',
  'mic.slash.fill': 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0z M6 10v2a6 6 0 0 0 12 0v-2 M12 18v4 M8 22h8 M2 2l20 20',
  phone: 'M5 3l4 4-2 3c2 4 3 5 7 7l3-2 4 4c-1 4-5 3-8 1C7 17 3 13 2 7c0-2 1-3 3-4z',
  'phone.badge.waveform': 'M5 3l4 4-2 3c2 4 3 5 7 7l3-2 4 4c-1 4-5 3-8 1C7 17 3 13 2 7c0-2 1-3 3-4z',
  'arrow.up': 'M12 20V4 M5 11l7-7 7 7',
  'paperplane.fill': 'M2 10l20-8-8 20-3-9z M11 13L22 2',
  'checkmark': 'M4 12l5 5L20 6',
};
export function Icon({ name, size = 24, color = colors.text, style }: { name: SymbolViewProps['name']; size?: number; color?: string; weight?: SymbolViewProps['weight']; style?: StyleProp<ViewStyle> }) {
  const key = typeof name === 'string' ? name : '';
  return <View style={[{ width: size, height: size }, style]}>
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[key] || 'M5 12h.01 M12 12h.01 M19 12h.01'} />
    </svg>
  </View>;
}
