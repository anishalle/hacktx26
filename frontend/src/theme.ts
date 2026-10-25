// Instagram iOS dark mode palette and type scale (SF Pro via the system font).
export const colors = {
  bg: '#0C1014',
  surface: '#262A30',
  surfaceAlt: '#1C1F24',
  searchBg: '#25292E',
  bubbleIn: '#26292E',
  bubbleInPressed: '#33373D',
  text: '#F5F5F5',
  textSecondary: '#A8A8A8',
  textTertiary: '#737373',
  separator: '#2B2F35',
  blue: '#3797F0',
  blueDot: '#4D66F5',
  red: '#FF3040',
  silhouetteBg: '#DBDBDB',
  silhouette: '#FFFFFF',
  sheetBg: '#1C1F24',
  sparkle: '#B79CFF',
  highlight: 'rgba(124, 92, 255, 0.45)',
  // Outgoing bubbles are tinted along Instagram's purple → blue gradient by position.
  gradTop: '#A033FF',
  gradMid: '#6E46F5',
  gradBottom: '#3B7CF6',
};

export const type = {
  title: { fontSize: 22, fontWeight: '700' as const, letterSpacing: -0.4 },
  headline: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 17, fontWeight: '400' as const, letterSpacing: -0.2 },
  rowName: { fontSize: 15, fontWeight: '400' as const },
  rowPreview: { fontSize: 15, fontWeight: '400' as const },
  footnote: { fontSize: 13, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
};

export function mixHex(a: string, b: string, t: number) {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (shift: number) => Math.round(((pa >> shift) & 255) * (1 - t) + ((pb >> shift) & 255) * t);
  return `#${((ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).padStart(6, '0')}`;
}
