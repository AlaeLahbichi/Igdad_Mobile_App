import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { AudioPlayerRow, BoxesOverlay, DetectionCard, Loader, Notice, SectionTitle } from '../../components/ui';
import { api, clock, pct, SavedTest } from '../../lib/api';
import { useTheme } from '../../lib/theme';

export default function TestScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [test, setTest] = useState<SavedTest & { threshold: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [viewW, setViewW] = useState(0);

  useEffect(() => {
    api.get<SavedTest & { threshold: number }>(`/api/m/tests/${id}`).then(setTest).catch((e) => setError(e.message));
  }, [id]);

  if (error) return <View style={{ padding: 16 }}><Notice icon="alert-circle" color={t.terre} text={error} /></View>;
  if (!test) return <Loader full label="Chargement du test…" />;
  const accent = test.kind === 'audio' ? t.majorelle : t.dark ? t.safran : '#C27A0E';
  const date = new Date(test.saved).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  return (
    <ScrollView contentContainerStyle={styles.page}>
      <Stack.Screen options={{ title: test.kind === 'audio' ? 'Test audio' : 'Test photo' }} />
      <Text style={{ color: t.mute, fontSize: 14 }}>
        {date} · {test.source} · seuil {pct(test.threshold)}
        {test.name ? ` · ${test.name}` : ''}
      </Text>
      {test.kind === 'audio' ? (
        <AudioPlayerRow uri={api.testMedia(test.id)} color={t.majorelle} title="Enregistrement" subtitle={test.duration ? clock(test.duration) : undefined} />
      ) : (
        <View
          style={[styles.photo, { aspectRatio: size.w && size.h ? size.w / size.h : 4 / 3, borderColor: t.line }]}
          onLayout={(e) => setViewW(e.nativeEvent.layout.width)}>
          <Image
            source={{ uri: api.testMedia(test.id) }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            onLoad={(e) => setSize({ w: e.source.width, h: e.source.height })}
          />
          {size.w > 0 && test.boxes && (
            <BoxesOverlay boxes={test.boxes} imgW={size.w} imgH={size.h} viewW={viewW} viewH={viewW * (size.h / size.w)} fit="contain" color={t.safran} />
          )}
        </View>
      )}
      <SectionTitle>{`Espèces détectées (${test.detections.length})`}</SectionTitle>
      {test.detections.length === 0 && <Notice icon="information-circle-outline" text="Aucune espèce n'avait dépassé le seuil." />}
      {test.detections.map((d) => (
        <DetectionCard key={d.species} d={d} accent={accent} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 40 },
  photo: { width: '100%', borderRadius: 18, overflow: 'hidden', borderWidth: 1 },
});
