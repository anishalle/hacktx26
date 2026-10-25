import { LinearGradient } from 'expo-linear-gradient';
import { Platform, StyleSheet, View } from 'react-native';

export function CloudBackdrop() {
  return <View pointerEvents="none" style={StyleSheet.absoluteFill}>
    <LinearGradient colors={['#d8d9ed', '#dee5f3', '#f1e5ef']} style={StyleSheet.absoluteFill} />
    <View style={styles.cloudBank}>
      {[[-90, 80, 290], [85, 45, 240], [220, 95, 310], [-35, 170, 270], [160, 180, 280]].map(([left, bottom, size], index) =>
        <View key={index} style={[styles.cloud, { left, bottom: bottom - 160, width: size, height: size * 0.65, borderRadius: size }]} />)}
    </View>
    <LinearGradient colors={['rgba(255,255,255,0)', '#fffafd']} style={styles.fade} />
  </View>;
}
const styles = StyleSheet.create({
  cloudBank: { position: 'absolute', left: 0, right: 0, bottom: 0, height: 300, overflow: 'hidden' },
  cloud: { position: 'absolute', backgroundColor: 'rgba(255,255,255,0.72)', shadowColor: '#fff', shadowOpacity: 1, shadowRadius: 28, shadowOffset: { width: 0, height: -8 }, ...Platform.select({ web: { filter: 'blur(15px)' } }) },
  fade: { position: 'absolute', bottom: 0, width: '100%', height: 140 },
});
