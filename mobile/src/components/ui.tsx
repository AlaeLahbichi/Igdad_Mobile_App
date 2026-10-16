import Ionicons from '@expo/vector-icons/Ionicons';
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';

import { api, Box, clock, Detection, pct } from '../lib/api';
import { displayName, useCatalog } from '../lib/catalog';
import { Theme, useTheme } from '../lib/theme';

// ---------------------------------------------------------------- chargement
export function Loader({ label, full = false }: { label?: string; full?: boolean }) {
  const t = useTheme();
  const spin = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    const b = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    );
    a.start();
    b.start();
    return () => {
      a.stop();
      b.stop();
    };
  }, [spin, pulse]);
  const size = full ? 150 : 84;
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.04] });
  return (
    <View style={[styles.loader, full && { flex: 1, backgroundColor: t.bg }]} accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={{ width: size + 24, height: size + 24, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View
          style={[
            StyleSheet.absoluteFill,
            {
              borderRadius: (size + 24) / 2,
              borderWidth: 4,
              borderColor: t.line,
              borderTopColor: t.safran,
              borderRightColor: t.cedre,
              transform: [{ rotate }],
            },
          ]}
        />
        <Animated.View style={{ transform: [{ scale }] }}>
          <Image source={require('../../assets/emblem.png')} style={{ width: size, height: size }} contentFit="contain" />
        </Animated.View>
      </View>
      {full && <Text style={[styles.brand, { color: t.cedre }]}>Igdad</Text>}
      {label ? <Text style={[styles.loaderLabel, { color: t.mute }]}>{label}</Text> : null}
    </View>
  );
}

export function LoadingOverlay({ label }: { label: string }) {
  const t = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.dark ? 'rgba(15,23,20,0.82)' : 'rgba(247,241,230,0.88)', justifyContent: 'center', zIndex: 20 }]}>
      <Loader label={label} />
    </View>
  );
}

// ---------------------------------------------------------------- éléments de base
export function Button({
  label,
  icon,
  onPress,
  color,
  textColor,
  variant = 'solid',
  disabled,
  busy,
  style,
}: {
  label: string;
  icon?: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  color?: string;
  textColor?: string;
  variant?: 'solid' | 'outline' | 'ghost';
  disabled?: boolean;
  busy?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const bg = color || t.cedre;
  const fg = variant === 'solid' ? textColor || t.onCedre : bg;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.button,
        variant === 'solid' && { backgroundColor: bg },
        variant === 'outline' && { borderWidth: 1.5, borderColor: bg },
        { opacity: disabled ? 0.45 : pressed ? 0.8 : 1 },
        style,
      ]}>
      {busy ? <ActivityIndicator color={fg} /> : icon ? <Ionicons name={icon} size={19} color={fg} /> : null}
      <Text style={[styles.buttonText, { color: fg }]}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  color,
  textOn,
}: {
  value: T;
  options: { value: T; label: string; icon: keyof typeof Ionicons.glyphMap }[];
  onChange: (v: T) => void;
  color: string;
  textOn: string;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: t.card, borderColor: t.line }]}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={o.value}
            onPress={() => onChange(o.value)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.segment, on && { backgroundColor: color }]}>
            <Ionicons name={o.icon} size={17} color={on ? textOn : t.mute} />
            <Text style={[styles.segmentText, { color: on ? textOn : t.mute }]}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  return <View style={[styles.card, { backgroundColor: t.card, borderColor: t.line }, style]}>{children}</View>;
}

export function SectionTitle({ children, right }: { children: string; right?: ReactNode }) {
  const t = useTheme();
  return (
    <View style={styles.sectionRow}>
      <Text style={[styles.sectionTitle, { color: t.text }]}>{children}</Text>
      {right}
    </View>
  );
}

export function Chip({ label, color, textColor }: { label: string; color: string; textColor?: string }) {
  return (
    <View style={[styles.chip, { backgroundColor: color }]}>
      <Text style={[styles.chipText, { color: textColor || '#FFFFFF' }]}>{label}</Text>
    </View>
  );
}

export function Notice({ icon, text, color }: { icon: keyof typeof Ionicons.glyphMap; text: string; color?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.notice, { borderColor: color || t.line, backgroundColor: t.card }]}>
      <Ionicons name={icon} size={20} color={color || t.mute} />
      <Text style={[styles.noticeText, { color: t.text }]}>{text}</Text>
    </View>
  );
}

export function ConfBar({ value, threshold, color }: { value: number; threshold: number; color: string }) {
  const t = useTheme();
  return (
    <View>
      <View style={[styles.bar, { backgroundColor: t.soft }]}>
        <View style={[styles.barFill, { width: `${Math.round(value * 100)}%`, backgroundColor: color }]} />
        <View style={[styles.barMark, { left: `${threshold * 100}%`, backgroundColor: t.mute }]} />
      </View>
      <View style={styles.barLegend}>
        <Text style={[styles.mono, { color: t.text }]}>confiance {pct(value)}</Text>
        <Text style={[styles.mono, { color: t.mute }]}>seuil {pct(threshold)}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------- résultat d'une détection
export function DetectionCard({ d, accent, fresh }: { d: Detection; accent: string; fresh?: boolean }) {
  const t = useTheme();
  const { bySpecies, threshold } = useCatalog();
  const s = bySpecies[d.species];
  const appear = useRef(new Animated.Value(fresh ? 0 : 1)).current;
  useEffect(() => {
    if (fresh) Animated.spring(appear, { toValue: 1, useNativeDriver: true, friction: 7 }).start();
  }, [fresh, appear]);
  return (
    <Animated.View
      style={{ opacity: appear, transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }}>
      <Card style={styles.detCard}>
        <Image source={{ uri: api.photo(d.species, 360) }} style={styles.detPhoto} contentFit="cover" transition={200} />
        <View style={styles.detBody}>
          <Text style={[styles.detName, { color: t.text }]} numberOfLines={2}>
            {displayName(s, d.species)}
          </Text>
          <Text style={[styles.detSci, { color: t.mute }]} numberOfLines={1}>
            {s?.sci}
          </Text>
          <ConfBar value={d.conf} threshold={threshold} color={t.oasis} />
          {d.segments.length > 0 && (
            <Text style={[styles.detSeg, { color: t.mute }]} numberOfLines={2}>
              Entendu à {d.segments.slice(0, 4).map(([a, b]) => `${clock(a)}–${clock(b)}`).join(', ')}
              {d.segments.length > 4 ? '…' : ''}
            </Text>
          )}
          <Button
            label="Voir le détail"
            icon="information-circle-outline"
            variant="outline"
            color={accent}
            onPress={() => router.push(`/species/${d.species}`)}
            style={{ paddingVertical: 8, marginTop: 4 }}
          />
        </View>
      </Card>
    </Animated.View>
  );
}

// ---------------------------------------------------------------- choix d'enregistrement d'un test
export function SaveTestCard({
  onSave,
  onSkip,
  state,
  kind,
}: {
  onSave: () => void;
  onSkip: () => void;
  state: 'ask' | 'saving' | 'saved' | 'skipped';
  kind: 'audio' | 'image';
}) {
  const t = useTheme();
  if (state === 'skipped') return null;
  if (state === 'saved')
    return <Notice icon="checkmark-circle" color={t.oasis} text="Test enregistré dans le data lake (Accueil › Tests enregistrés)." />;
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
        <Ionicons name="save-outline" size={22} color={t.cedre} />
        <Text style={[styles.saveTitle, { color: t.text }]}>Enregistrer ce test ?</Text>
      </View>
      <Text style={{ color: t.mute, fontSize: 14 }}>
        {kind === 'audio'
          ? "L'audio et les espèces détectées seront gardés pour les revoir plus tard."
          : "La photo et les oiseaux détectés seront gardés pour les revoir plus tard."}
      </Text>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button label="Enregistrer" icon="cloud-upload-outline" onPress={onSave} busy={state === 'saving'} style={{ flex: 1 }} />
        <Button label="Non merci" variant="outline" color={t.mute} onPress={onSkip} style={{ flex: 1 }} />
      </View>
    </Card>
  );
}

// ---------------------------------------------------------------- cadres de détection sur une image
export function BoxesOverlay({
  boxes,
  imgW,
  imgH,
  viewW,
  viewH,
  fit,
  color,
}: {
  boxes: Box[];
  imgW: number;
  imgH: number;
  viewW: number;
  viewH: number;
  fit: 'contain' | 'cover';
  color: string;
}) {
  const { bySpecies } = useCatalog();
  if (!imgW || !imgH || !viewW || !viewH) return null;
  const scale = fit === 'cover' ? Math.max(viewW / imgW, viewH / imgH) : Math.min(viewW / imgW, viewH / imgH);
  const dx = (viewW - imgW * scale) / 2;
  const dy = (viewH - imgH * scale) / 2;
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      {boxes.map((b, i) => {
        const [x1, y1, x2, y2] = b.box;
        const left = dx + x1 * imgW * scale;
        const top = dy + y1 * imgH * scale;
        return (
          <View
            key={i}
            style={{
              position: 'absolute',
              left,
              top,
              width: (x2 - x1) * imgW * scale,
              height: (y2 - y1) * imgH * scale,
              borderWidth: 3,
              borderColor: color,
              borderRadius: 8,
            }}>
            <View style={[styles.boxLabel, { backgroundColor: color }]}>
              <Text style={styles.boxLabelText} numberOfLines={1}>
                {displayName(bySpecies[b.species], b.species)} · {pct(b.conf)}
              </Text>
            </View>
          </View>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- lecteur audio (chant, test enregistré)
export function AudioPlayerRow({ uri, title, subtitle, color }: { uri: string; title: string; subtitle?: string; color: string }) {
  const t = useTheme();
  const player = useAudioPlayer(uri, { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const [width, setWidth] = useState(1);
  const progress = status.duration ? status.currentTime / status.duration : 0;

  async function toggle() {
    if (status.playing) return player.pause();
    await setAudioModeAsync({ playsInSilentMode: true, allowsRecording: false });
    if (status.didJustFinish || (status.duration && status.currentTime >= status.duration - 0.2)) await player.seekTo(0);
    player.play();
  }

  return (
    <View style={[styles.player, { backgroundColor: t.card, borderColor: t.line }]}>
      <Pressable
        onPress={toggle}
        accessibilityRole="button"
        accessibilityLabel={status.playing ? 'Pause' : 'Écouter'}
        style={[styles.playBtn, { backgroundColor: color }]}>
        {status.isBuffering && !status.isLoaded ? (
          <ActivityIndicator color="#FFFFFF" />
        ) : (
          <Ionicons name={status.playing ? 'pause' : 'play'} size={22} color="#FFFFFF" style={{ marginLeft: status.playing ? 0 : 3 }} />
        )}
      </Pressable>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={{ color: t.text, fontWeight: '600', fontSize: 15 }} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: t.mute, fontSize: 12 }} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Pressable
          onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
          onPress={(e) => status.duration && player.seekTo((e.nativeEvent.locationX / width) * status.duration)}
          style={{ paddingVertical: 6 }}>
          <View style={[styles.bar, { backgroundColor: t.soft, height: 6 }]}>
            <View style={[styles.barFill, { width: `${progress * 100}%`, backgroundColor: color }]} />
          </View>
        </Pressable>
        <Text style={[styles.mono, { color: t.mute }]}>
          {clock(status.currentTime)} / {clock(status.duration || 0)}
        </Text>
      </View>
    </View>
  );
}

export function useStyles() {
  const t = useTheme();
  return { t, styles };
}

export const styles = StyleSheet.create({
  loader: { alignItems: 'center', justifyContent: 'center', gap: 14, padding: 24 },
  brand: { fontSize: 40, fontWeight: '800', letterSpacing: -1.5 },
  loaderLabel: { fontSize: 15, textAlign: 'center' },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 13,
    paddingHorizontal: 16,
    borderRadius: 14,
  },
  buttonText: { fontSize: 15, fontWeight: '600' },
  segmented: { flexDirection: 'row', borderWidth: 1, borderRadius: 14, padding: 4, gap: 4 },
  segment: { flex: 1, flexDirection: 'row', gap: 6, alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 10 },
  segmentText: { fontSize: 14, fontWeight: '600' },
  card: { borderWidth: 1, borderRadius: 18, padding: 14 },
  sectionRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 8 },
  sectionTitle: { fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  chip: { paddingHorizontal: 9, paddingVertical: 4, borderRadius: 99, alignSelf: 'flex-start' },
  chipText: { fontSize: 12, fontWeight: '700' },
  notice: { flexDirection: 'row', gap: 10, alignItems: 'center', borderWidth: 1, borderRadius: 14, padding: 12 },
  noticeText: { flex: 1, fontSize: 14, lineHeight: 20 },
  bar: { height: 8, borderRadius: 99, overflow: 'hidden', position: 'relative' },
  barFill: { height: '100%', borderRadius: 99 },
  barMark: { position: 'absolute', top: 0, bottom: 0, width: 2 },
  barLegend: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 },
  mono: { fontSize: 12, fontVariant: ['tabular-nums'] },
  detCard: { flexDirection: 'row', gap: 12, padding: 10 },
  detPhoto: { width: 104, height: 132, borderRadius: 12 },
  detBody: { flex: 1, gap: 4 },
  detName: { fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
  detSci: { fontSize: 13, fontStyle: 'italic', marginBottom: 2 },
  detSeg: { fontSize: 12 },
  saveTitle: { fontSize: 17, fontWeight: '700' },
  boxLabel: { position: 'absolute', top: -24, left: -3, paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6, maxWidth: 220 },
  boxLabelText: { color: '#1C2421', fontSize: 11, fontWeight: '700' },
  player: { flexDirection: 'row', gap: 12, alignItems: 'center', borderWidth: 1, borderRadius: 16, padding: 12 },
  playBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
});

export type { Theme };
