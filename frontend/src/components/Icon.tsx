import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { StyleProp, ViewStyle } from 'react-native';

import { colors } from '@/theme';

type Props = {
  name: SymbolViewProps['name'];
  size?: number;
  color?: string;
  weight?: SymbolViewProps['weight'];
  style?: StyleProp<ViewStyle>;
};

/** SF Symbol. Instagram's outline icons map closely to SF Symbols at regular/medium weight. */
export function Icon({ name, size = 24, color = colors.text, weight = 'regular', style }: Props) {
  return <SymbolView name={name} size={size} tintColor={color} weight={weight} style={[{ width: size, height: size }, style]} />;
}
