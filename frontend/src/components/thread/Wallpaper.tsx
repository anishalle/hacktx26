import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, View } from 'react-native';

/** Subtle generated chat theme: dark gradient with faint court lines (stand-in for a themed wallpaper). */
export function Wallpaper() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <LinearGradient colors={['#26262A', '#1D1E21', '#141518']} style={StyleSheet.absoluteFill} />
      <View style={[styles.line, { top: '18%', backgroundColor: 'rgba(214,60,60,0.22)', transform: [{ rotate: '-24deg' }] }]} />
      <View style={[styles.line, { top: '24%', backgroundColor: 'rgba(222,180,40,0.18)', transform: [{ rotate: '-24deg' }] }]} />
      <View style={[styles.line, { top: '52%', backgroundColor: 'rgba(214,60,60,0.16)', transform: [{ rotate: '12deg' }] }]} />
      <View style={[styles.line, { top: '78%', backgroundColor: 'rgba(80,120,230,0.16)', transform: [{ rotate: '-18deg' }] }]} />
      <View style={[styles.ring, { top: '38%', left: '30%' }]} />
      <View style={[styles.ring, { top: '62%', left: '-20%', width: 360, height: 360, borderRadius: 180 }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  line: { position: 'absolute', left: '-30%', width: '160%', height: 6, borderRadius: 3 },
  ring: {
    position: 'absolute',
    width: 300,
    height: 300,
    borderRadius: 150,
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.035)',
  },
});
