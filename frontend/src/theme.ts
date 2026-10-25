// Shared surfaces and accents for conversations, context sheets and calls.
export const colors = {
  bg: '#F5F5F7',
  surface: '#FFFFFF',
  surfaceAlt: '#EFEFF3',
  searchBg: '#EDEDF1',
  bubbleIn: '#E9E9ED',
  bubbleInPressed: '#DEDEE5',
  text: '#1D1D1F',
  textSecondary: '#6E6E73',
  textTertiary: '#85858C',
  separator: '#E1E1E6',
  blue: '#007AFF',
  action: '#0068D9',
  blueDot: '#007AFF',
  red: '#D83B52',
  silhouetteBg: '#E4ECF9',
  silhouette: '#3768A6',
  sheetBg: '#F9F9FB',
  sparkle: '#0068D9',
  highlight: 'rgba(0, 122, 255, 0.15)',
  gradTop: '#1C70DE',
  gradMid: '#166BD7',
  gradBottom: '#1267D0',
  accentSoft: '#E7F0FF',
  mint: '#267B61',
};

export const type = {
  title: { fontSize: 30, fontWeight: '700' as const, letterSpacing: -1 },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 16, fontWeight: '400' as const, letterSpacing: -0.2 },
  rowName: { fontSize: 16, fontWeight: '600' as const },
  rowPreview: { fontSize: 14, fontWeight: '400' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
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
