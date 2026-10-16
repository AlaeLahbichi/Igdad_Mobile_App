import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useFocusEffect } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  BoxesOverlay,
  Button,
  Card,
  DetectionCard,
  LoadingOverlay,
  Notice,
  SaveTestCard,
  Segmented,
  SectionTitle,
} from '../../components/ui';
import { api, Box, Detection, newSession, pct } from '../../lib/api';
import { displayName, useCatalog } from '../../lib/catalog';
import { cachedPosition, getPosition } from '../../lib/location';
import { useTheme } from '../../lib/theme';

type Mode = 'live' | 'file';
type SaveState = 'ask' | 'saving' | 'saved' | 'skipped';
type Reply = { width: number; height: number; boxes: Box[]; best_below: Box | null; new: string[]; detections: Detection[] };

export default function ImageScreen() {
  const t = useTheme();
  const accent = t.dark ? t.safran : '#C27A0E'; // safran assombri pour le texte sur fond clair
  const [focused, setFocused] = useState(true);
  const { threshold, bySpecies } = useCatalog();
  const [mode, setMode] = useState<Mode>('live');
  const [session, setSession] = useState(newSession);
  const [detections, setDetections] = useState<Detection[]>([]);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>('ask');
  const [last, setLast] = useState<Reply | null>(null);

  // --- caméra en direct
  const [perm, requestPerm] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [live, setLive] = useState(false);
  const [stopped, setStopped] = useState(false);
  const liveRef = useRef(false);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [view, setView] = useState({ w: 0, h: 0 });

  // --- import
  const [photo, setPhoto] = useState<{ uri: string; w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [photoW, setPhotoW] = useState(0);

  // la caméra s'arrête quand on change d'onglet
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => {
        setFocused(false);
        if (liveRef.current) stopLive();
      };
    }, []),
  );

  function reset(next?: Mode) {
    liveRef.current = false;
    setLive(false);
    setStopped(false);
    setSession(newSession());
    setDetections([]);
    setFresh(new Set());
    setError(null);
    setSave('ask');
    setLast(null);
    setPhoto(null);
    if (next) setMode(next);
  }

  function handle(r: Reply) {
    setLast(r);
    setDetections(r.detections);
    if (r.new.length) {
      setFresh((f) => new Set([...f, ...r.new]));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    }
  }

  async function startLive() {
    reset();
    if (!perm?.granted) {
      const p = await requestPerm();
      if (!p.granted) {
        setError("Igdad a besoin de la caméra. Autorisez-la dans Réglages › Igdad (ou Expo Go) › Appareil photo.");
        return;
      }
    }
    getPosition();
    liveRef.current = true;
    setLive(true);
    loop();
  }

  async function loop() {
    while (liveRef.current) {
      try {
        const pic = await cam.current?.takePictureAsync({ quality: 0.35, base64: true, shutterSound: false });
        if (pic?.base64 && liveRef.current) {
          const r = await api.post<Reply>('/api/m/image', { session: sessionRef.current, mode: 'live', data: pic.base64, ...cachedPosition() }, 20000);
          if (liveRef.current) handle(r);
          setError(null);
        }
      } catch (e: any) {
        setError(e.message);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }

  function stopLive() {
    liveRef.current = false;
    setLive(false);
    setStopped(true);
  }

  async function pick(source: 'library' | 'camera') {
    const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ['images'], base64: true, quality: 0.8 };
    if (source === 'camera') {
      const p = await ImagePicker.requestCameraPermissionsAsync();
      if (!p.granted) return setError("Igdad a besoin de la caméra pour prendre la photo.");
    }
    const res = source === 'camera' ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (res.canceled || !res.assets?.length) return;
    const a = res.assets[0];
    reset();
    setPhoto({ uri: a.uri, w: a.width, h: a.height });
    setBusy(true);
    try {
      const r = await api.post<Reply>('/api/m/image', { session: sessionRef.current, mode: 'import', data: a.base64, ...(await getPosition()) }, 30000);
      setPhoto({ uri: a.uri, w: r.width, h: r.height });
      handle(r);
      setStopped(true);
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

  const below = last && !last.boxes.length && last.best_below;
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={styles.page}>
        <View>
          <Text style={[styles.title, { color: t.text }]}>Reconnaître par la photo</Text>
          <Text style={{ color: t.mute, fontSize: 14 }}>
            Chaque oiseau au-dessus de {pct(threshold)} de confiance est encadré et nommé.
          </Text>
        </View>
        <Segmented<Mode>
          value={mode}
          onChange={(m) => reset(m)}
          color={t.safran}
          textOn={t.onSafran}
          options={[
            { value: 'live', label: 'Temps réel', icon: 'videocam-outline' },
            { value: 'file', label: 'Importer', icon: 'images-outline' },
          ]}
        />

        {mode === 'live' ? (
          <View style={{ gap: 12 }}>
            <View
              style={[styles.camera, { borderColor: live ? t.safran : t.line, backgroundColor: t.card }]}
              onLayout={(e) => setView({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
              {live && focused ? (
                <>
                  <CameraView
                    ref={cam}
                    style={StyleSheet.absoluteFill}
                    facing="back"
                    animateShutter={false}
                    onCameraReady={() => setReady(true)}
                  />
                  {last && (
                    <BoxesOverlay boxes={last.boxes} imgW={last.width} imgH={last.height} viewW={view.w} viewH={view.h} fit="cover" color={t.safran} />
                  )}
                  {!ready && <ActivityIndicator style={StyleSheet.absoluteFill} color={t.safran} />}
                  <View style={[styles.liveTag, { backgroundColor: t.terre }]}>
                    <View style={styles.liveDot} />
                    <Text style={{ color: '#FFFFFF', fontWeight: '700', fontSize: 12 }}>EN DIRECT</Text>
                  </View>
                </>
              ) : (
                <View style={styles.cameraIdle}>
                  <Ionicons name="camera-outline" size={44} color={t.mute} />
                  <Text style={{ color: t.mute, textAlign: 'center', fontSize: 14 }}>
                    {stopped ? 'Caméra arrêtée.' : "Lancez la caméra et visez l'oiseau. L'analyse se fait environ une fois par seconde."}
                  </Text>
                </View>
              )}
            </View>
            <Button
              label={live ? 'Arrêter la caméra' : stopped ? 'Relancer la caméra' : 'Lancer la caméra'}
              icon={live ? 'stop' : 'videocam'}
              color={live ? t.terre : t.safran}
              textColor={live ? '#FFFFFF' : t.onSafran}
              onPress={live ? stopLive : startLive}
            />
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            {photo ? (
              <View
                style={[styles.photoBox, { aspectRatio: photo.w / photo.h, borderColor: t.line }]}
                onLayout={(e) => setPhotoW(e.nativeEvent.layout.width)}>
                <Image source={{ uri: photo.uri }} style={StyleSheet.absoluteFill} contentFit="contain" />
                {last && (
                  <BoxesOverlay
                    boxes={last.boxes}
                    imgW={photo.w}
                    imgH={photo.h}
                    viewW={photoW}
                    viewH={photoW * (photo.h / photo.w)}
                    fit="contain"
                    color={t.safran}
                  />
                )}
              </View>
            ) : (
              <Card style={[styles.cameraIdle, { minHeight: 180 }]}>
                <Ionicons name="image-outline" size={44} color={t.mute} />
                <Text style={{ color: t.mute, textAlign: 'center', fontSize: 14 }}>
                  Choisissez une photo dans la galerie ou prenez-en une.
                </Text>
              </Card>
            )}
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button label="Galerie" icon="images" color={t.safran} textColor={t.onSafran} onPress={() => pick('library')} style={{ flex: 1 }} />
              <Button label="Prendre une photo" icon="camera" variant="outline" color={accent} onPress={() => pick('camera')} style={{ flex: 1.3 }} />
            </View>
          </View>
        )}

        {error && <Notice icon="alert-circle" color={t.terre} text={error} />}
        {below && (
          <Notice
            icon="eye-outline"
            text={`Oiseau probable : ${displayName(bySpecies[below.species], below.species)} (${pct(below.conf)}), sous le seuil de ${pct(threshold)}. Il n'est pas retenu.`}
          />
        )}
        {stopped && last && !last.boxes.length && !below && mode === 'file' && (
          <Notice icon="search-outline" text="Aucun oiseau reconnu sur cette photo." />
        )}

        {detections.length > 0 && <SectionTitle>{`Espèces détectées (${detections.length})`}</SectionTitle>}
        {detections.map((d) => (
          <DetectionCard key={d.species} d={d} accent={accent} fresh={fresh.has(d.species)} />
        ))}

        {stopped && last && <SaveTestCard kind="image" state={save} onSave={saveTest} onSkip={() => setSave('skipped')} />}
      </ScrollView>
      {busy && <LoadingOverlay label="Analyse de la photo…" />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  camera: { width: '100%', aspectRatio: 3 / 4, borderRadius: 22, overflow: 'hidden', borderWidth: 2 },
  cameraIdle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  liveTag: { position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' },
  photoBox: { width: '100%', borderRadius: 18, overflow: 'hidden', borderWidth: 1 },
});
