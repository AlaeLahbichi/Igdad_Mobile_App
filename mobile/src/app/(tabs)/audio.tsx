import Ionicons from '@expo/vector-icons/Ionicons';
import { requestRecordingPermissionsAsync, setAudioModeAsync, useAudioStream } from 'expo-audio';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  Button,
  Card,
  DetectionCard,
  LoadingOverlay,
  Notice,
  SaveTestCard,
  Segmented,
  SectionTitle,
} from '../../components/ui';
import { api, bytesToBase64, clock, Detection, newSession, pct } from '../../lib/api';
import { displayName, useCatalog } from '../../lib/catalog';
import { cachedPosition, getPosition } from '../../lib/location';
import { useTheme } from '../../lib/theme';

type Mode = 'live' | 'file';
type SaveState = 'ask' | 'saving' | 'saved' | 'skipped';
type StreamReply = {
  top: { species: string; prob: number }[];
  level: number;
  seconds: number;
  new: string[];
  detections: Detection[];
};
type FileReply = { duration: number; detections: Detection[]; timeline: { t: number; species: string; conf: number }[] };

const SEND_EVERY_MS = 1200;

export default function AudioScreen() {
  const t = useTheme();
  const { threshold, bySpecies } = useCatalog();
  const [mode, setMode] = useState<Mode>('live');
  const [session, setSession] = useState(newSession);
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle');
  const [detections, setDetections] = useState<Detection[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>('ask');

  // --- temps réel
  const [top, setTop] = useState<StreamReply['top']>([]);
  const [seconds, setSeconds] = useState(0);
  const [levels, setLevels] = useState<number[]>(Array(28).fill(0));
  const pending = useRef<Int16Array[]>([]);
  const fmt = useRef({ sr: 32000, ch: 1 });
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const { stream } = useAudioStream({
    sampleRate: 32000,
    channels: 1,
    encoding: 'int16',
    onBuffer: (b) => {
      fmt.current = { sr: b.sampleRate, ch: b.channels };
      pending.current.push(new Int16Array(b.data.slice(0)));
    },
  });

  // --- import
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<{ name: string; reply: FileReply } | null>(null);

  useEffect(() => () => stopTimers(), []);

  // l'écoute s'arrête si l'on quitte l'onglet
  useFocusEffect(
    useCallback(
      () => () => {
        if (timer.current) {
          stopTimers();
          try {
            stream.stop();
          } catch {}
          setPhase('done');
        }
      },
      [stream],
    ),
  );

  function stopTimers() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }

  function reset(next?: Mode) {
    stopTimers();
    setSession(newSession());
    setPhase('idle');
    setDetections([]);
    setFresh(new Set());
    setTop([]);
    setSeconds(0);
    setLevels(Array(28).fill(0));
    setError(null);
    setSave('ask');
    setFile(null);
    pending.current = [];
    if (next) setMode(next);
  }

  async function flush() {
    if (inFlight.current || pending.current.length === 0) return;
    const chunks = pending.current;
    pending.current = [];
    const n = chunks.reduce((a, c) => a + c.length, 0);
    let pcm = new Int16Array(n);
    let o = 0;
    for (const c of chunks) {
      pcm.set(c, o);
      o += c.length;
    }
    const { sr, ch } = fmt.current;
    if (ch > 1) {
      const mono = new Int16Array(Math.floor(pcm.length / ch));
      for (let i = 0; i < mono.length; i++) {
        let s = 0;
        for (let k = 0; k < ch; k++) s += pcm[i * ch + k];
        mono[i] = s / ch;
      }
      pcm = mono;
    }
    inFlight.current = true;
    try {
      const r = await api.post<StreamReply>('/api/m/audio/stream', {
        session: sessionRef.current,
        ...cachedPosition(),
        sr,
        pcm: bytesToBase64(new Uint8Array(pcm.buffer)),
      });
      setTop(r.top);
      setSeconds(r.seconds);
      setLevels((l) => [...l.slice(1), Math.min(1, Math.sqrt(r.level) * 2.2)]);
      setDetections(r.detections);
      if (r.new.length) {
        setFresh((f) => new Set([...f, ...r.new]));
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
      }
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      inFlight.current = false;
    }
  }

  async function start() {
    reset();
    try {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError("Igdad a besoin du micro. Autorisez-le dans Réglages › Igdad (ou Expo Go) › Micro.");
        return;
      }
      getPosition();
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await stream.start();
      setPhase('running');
      timer.current = setInterval(flush, SEND_EVERY_MS);
    } catch (e: any) {
      setError(`Impossible de démarrer l'écoute : ${e?.message ?? e}`);
    }
  }

  async function stop() {
    stopTimers();
    try {
      stream.stop();
    } catch {}
    await flush();
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true }).catch(() => {});
    setPhase('done');
  }

  async function pickFile() {
    const res = await DocumentPicker.getDocumentAsync({ type: ['audio/*'], copyToCacheDirectory: true });
    if (res.canceled || !res.assets?.length) return;
    const asset = res.assets[0];
    reset();
    setBusy(true);
    try {
      const data = await new File(asset.uri).base64();
      const reply = await api.post<FileReply>(
        '/api/m/audio/file',
        { session: sessionRef.current, name: asset.name, data, ...(await getPosition()) },
        180000,
      );
      setFile({ name: asset.name, reply });
      setDetections(reply.detections);
      setFresh(new Set(reply.detections.map((d) => d.species)));
      setPhase('done');
      if (reply.detections.length) Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function saveTest() {
    setSave('saving');
    try {
      await api.post('/api/m/save', { session });
      setSave('saved');
    } catch (e: any) {
      setError(e.message);
      setSave('ask');
    }
  }

  const running = phase === 'running';
  const best = top[0];
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={styles.page}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Reconnaître par le chant</Text>
          <Text style={{ color: t.mute, fontSize: 14 }}>
            Seules les espèces au-dessus de {pct(threshold)} de confiance sont retenues.
          </Text>
        </View>
        <Segmented<Mode>
          value={mode}
          onChange={(m) => !running && reset(m)}
          color={t.majorelle}
          textOn={t.onMajorelle}
          options={[
            { value: 'live', label: 'Temps réel', icon: 'radio-outline' },
            { value: 'file', label: 'Importer', icon: 'folder-open-outline' },
          ]}
        />

        {mode === 'live' ? (
          <Card style={{ alignItems: 'center', gap: 14, paddingVertical: 22 }}>
            <View style={styles.meter}>
              {levels.map((l, i) => (
                <View
                  key={i}
                  style={{
                    flex: 1,
                    height: `${8 + l * 92}%`,
                    borderRadius: 3,
                    backgroundColor: running ? t.majorelle : t.line,
                    opacity: running ? 0.35 + (i / levels.length) * 0.65 : 1,
                  }}
                />
              ))}
            </View>
            <MicButton running={running} onPress={running ? stop : start} color={t.majorelle} />
            <Text style={[styles.timer, { color: t.text }]}>{clock(seconds)}</Text>
            <Text style={{ color: t.mute, fontSize: 14, textAlign: 'center' }}>
              {running
                ? best
                  ? best.prob >= threshold
                    ? `J'entends : ${displayName(bySpecies[best.species], best.species)} (${pct(best.prob)})`
                    : `Hypothèse : ${displayName(bySpecies[best.species], best.species)} · ${pct(best.prob)}, sous le seuil`
                  : 'Écoute en cours… approchez le téléphone du chant.'
                : phase === 'done'
                  ? 'Écoute terminée.'
                  : "Touchez le micro pour lancer l'écoute en direct."}
            </Text>
          </Card>
        ) : (
          <Card style={{ gap: 12 }}>
            <View style={{ flexDirection: 'row', gap: 12, alignItems: 'center' }}>
              <Ionicons name="musical-notes" size={26} color={t.majorelle} />
              <Text style={{ color: t.text, fontSize: 15, flex: 1, lineHeight: 21 }}>
                {file
                  ? `${file.name} · ${clock(file.reply.duration)}`
                  : 'Choisissez un enregistrement (m4a, mp3, wav…). Il est découpé en fenêtres de 5 s pour trouver toutes les espèces.'}
              </Text>
            </View>
            {file && <Timeline reply={file.reply} threshold={threshold} />}
            <Button label={file ? 'Analyser un autre fichier' : 'Importer un audio'} icon="cloud-upload-outline" color={t.majorelle} textColor={t.onMajorelle} onPress={pickFile} />
          </Card>
        )}

        {error && <Notice icon="alert-circle" color={t.terre} text={error} />}

        {(detections.length > 0 || phase === 'done') && (
          <SectionTitle>{`Espèces détectées (${detections.length})`}</SectionTitle>
        )}
        {phase === 'done' && detections.length === 0 && (
          <Notice icon="ear-outline" text={`Aucune espèce n'a dépassé ${pct(threshold)} de confiance. Essayez plus près de l'oiseau ou avec moins de bruit.`} />
        )}
        {detections.map((d) => (
          <DetectionCard key={d.species} d={d} accent={t.majorelle} fresh={fresh.has(d.species)} />
        ))}

        {phase === 'done' && (
          <SaveTestCard kind="audio" state={save} onSave={saveTest} onSkip={() => setSave('skipped')} />
        )}
        {phase === 'done' && mode === 'live' && (
          <Button label="Nouvelle écoute" icon="refresh" variant="outline" color={t.majorelle} onPress={start} />
        )}
      </ScrollView>
      {busy && <LoadingOverlay label="Analyse de l'audio…" />}
    </SafeAreaView>
  );
}

function MicButton({ running, onPress, color }: { running: boolean; onPress: () => void; color: string }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!running) return;
    const a = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }));
    a.start();
    return () => {
      a.stop();
      pulse.setValue(0);
    };
  }, [running, pulse]);
  return (
    <View style={{ width: 120, height: 120, alignItems: 'center', justifyContent: 'center' }}>
      {running && (
        <Animated.View
          style={{
            position: 'absolute',
            width: 96,
            height: 96,
            borderRadius: 48,
            backgroundColor: color,
            opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0] }),
            transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.5] }) }],
          }}
        />
      )}
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={running ? "Arrêter l'écoute" : "Lancer l'écoute"}
        style={({ pressed }) => [styles.mic, { backgroundColor: color, opacity: pressed ? 0.85 : 1 }]}>
        <Ionicons name={running ? 'stop' : 'mic'} size={40} color="#FFFFFF" />
      </Pressable>
    </View>
  );
}

function Timeline({ reply, threshold }: { reply: FileReply; threshold: number }) {
  const t = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <View style={styles.timeline}>
        {reply.timeline.map((w, i) => (
          <View key={i} style={{ flex: 1, backgroundColor: w.conf >= threshold ? t.oasis : t.soft }} />
        ))}
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: t.mute, fontSize: 11 }}>0:00</Text>
        <Text style={{ color: t.mute, fontSize: 11 }}>en vert : passages reconnus</Text>
        <Text style={{ color: t.mute, fontSize: 11 }}>{clock(reply.duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  meter: { flexDirection: 'row', alignItems: 'center', gap: 3, height: 54, width: '100%' },
  mic: { width: 96, height: 96, borderRadius: 48, alignItems: 'center', justifyContent: 'center' },
  timer: { fontSize: 28, fontWeight: '700', fontVariant: ['tabular-nums'] },
  timeline: { flexDirection: 'row', height: 14, borderRadius: 7, overflow: 'hidden', gap: 1 },
});
