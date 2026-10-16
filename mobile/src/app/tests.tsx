import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, Loader, Notice } from '../components/ui';
import { api, clock, SavedTest } from '../lib/api';
import { displayName, useCatalog } from '../lib/catalog';
import { useTheme } from '../lib/theme';

export default function Tests() {
  const t = useTheme();
  const { bySpecies } = useCatalog();
  const [tests, setTests] = useState<SavedTest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<SavedTest[]>('/api/m/tests').then(setTests).catch((e) => setError(e.message));
  }, []);

  if (error) return <View style={{ padding: 16 }}><Notice icon="alert-circle" color={t.terre} text={error} /></View>;
  if (!tests) return <Loader full label="Chargement des tests…" />;
  return (
    <FlatList
      data={tests}
      keyExtractor={(x) => x.id}
      contentContainerStyle={{ padding: 16, gap: 10 }}
      ListEmptyComponent={<Notice icon="save-outline" text="Aucun test enregistré pour l'instant." />}
      renderItem={({ item: x }) => (
        <Pressable onPress={() => router.push(`/test/${x.id}`)}>
          <Card style={styles.row}>
            <View style={[styles.icon, { backgroundColor: x.kind === 'audio' ? t.majorelleSoft : t.safranSoft }]}>
              <Ionicons name={x.kind === 'audio' ? 'mic' : 'camera'} size={20} color={x.kind === 'audio' ? t.majorelle : t.dark ? t.safran : '#C27A0E'} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={2}>
                {x.detections.length
                  ? x.detections.map((d) => displayName(bySpecies[d.species], d.species)).join(', ')
                  : 'Aucune espèce au-dessus du seuil'}
              </Text>
              <Text style={{ color: t.mute, fontSize: 12 }}>
                {new Date(x.saved).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })} · {x.kind === 'audio' ? 'Chant' : 'Photo'} ·{' '}
                {x.source}
                {x.duration ? ` · ${clock(x.duration)}` : ''}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={t.mute} />
          </Card>
        </Pressable>
      )}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
