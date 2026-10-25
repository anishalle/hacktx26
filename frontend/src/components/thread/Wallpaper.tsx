import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

/** Connect's soft rose and lavender conversation background. */
export function Wallpaper() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <LinearGradient colors={['#eddae7', '#e0dfee', '#f4e7ef', '#fff8fc']} locations={[0, 0.45, 0.8, 1]} style={StyleSheet.absoluteFill} />
  </View>;
}
