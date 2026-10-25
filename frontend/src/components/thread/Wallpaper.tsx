import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';
export function Wallpaper() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={['#FAFBFF', '#FFFFFF', '#F7F8FC']} locations={[0, 0.45, 1]} style={StyleSheet.absoluteFill} />
    </View>
  );
}
