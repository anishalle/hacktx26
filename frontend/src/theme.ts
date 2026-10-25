// Light iMessage surfaces and accents, tuned to UIKit's system colors.
export const colors = {
  bg: '#FFFFFF',
  grouped: '#F2F2F7',
  surface: '#FFFFFF',
  surfaceAlt: '#E9E9EB',
  searchBg: 'rgba(118,118,128,0.12)',
  bubbleIn: '#E9E9EB',
  bubbleInPressed: '#DCDCDF',
  text: '#000000',
  textSecondary: 'rgba(60,60,67,0.6)',
  textTertiary: 'rgba(60,60,67,0.3)',
  separator: 'rgba(60,60,67,0.29)',
  blue: '#007AFF',
  action: '#007AFF',
  blueDot: '#007AFF',
  green: '#34C759',
  red: '#FF3B30',
  silhouetteBg: '#E4ECF9',
  silhouette: '#3768A6',
  sheetBg: '#F2F2F7',
  sparkle: '#007AFF',
  highlight: 'rgba(0,122,255,0.15)',
  gradTop: '#007AFF',
  gradMid: '#007AFF',
  gradBottom: '#007AFF',
  accentSoft: '#E7F0FF',
  mint: '#267B61',
};

// HIG text styles. No negative tracking; 11pt (caption2) is the floor.
export const type = {
  largeTitle: { fontSize: 34, fontWeight: '700' as const },
  title2: { fontSize: 22, fontWeight: '700' as const },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 17, fontWeight: '400' as const },
  subheadline: { fontSize: 15, fontWeight: '400' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  caption2: { fontSize: 11, fontWeight: '400' as const },
};

export function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}

// Video calls keep dark chrome so controls stay readable over camera feeds.
export const callColors = {
  ...colors,
  bg: '#080B10',
  surface: '#242830',
  surfaceAlt: '#171D26',
  text: '#F5F7FC',
  textSecondary: '#AAB4C3',
  textTertiary: '#8F9BAE',
  separator: '#343D4A',
  blue: '#8DB1FF',
  sparkle: '#B6CCFF',
};
