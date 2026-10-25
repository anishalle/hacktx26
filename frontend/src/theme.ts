// Connect's rose and lavender palette and system type scale.
export const colors = {
  bg: '#F1E5EB',
  surface: '#FFF9FC',
  surfaceAlt: '#F9F1F6',
  searchBg: '#FFFFFF99',
  bubbleIn: '#FFFCFE',
  bubbleInPressed: '#F5E3EF',
  text: '#332936',
  textSecondary: '#766575',
  textTertiary: '#887484',
  separator: '#E5D6E2',
  blue: '#88627F',
  blueDot: '#A37598',
  red: '#FF3040',
  silhouetteBg: '#DBDBDB',
  silhouette: '#FFFFFF',
  sheetBg: '#FFF9FC',
  sparkle: '#B79CFF',
  highlight: 'rgba(164, 115, 152, 0.24)',
  // Outgoing bubbles are tinted along Instagram's purple → blue gradient by position.
  gradTop: '#F5D7E8',
  gradMid: '#F2DDEB',
  gradBottom: '#EEDFEB',
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
