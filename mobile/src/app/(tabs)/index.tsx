import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Card, SectionTitle } from '../../components/ui';
import { api, pct, SavedTest } from '../../lib/api';
import { displayName, useCatalog } from '../../lib/catalog';
import { useTheme } from '../../lib/theme';

export default function Home() {
  const t = useTheme();
  const { list, threshold, bySpecies } = useCatalog();
  const [tests, setTests] = useState<SavedTest[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      setTests(await api.get<SavedTest[]>('/api/m/tests'));
    } catch {
      setTests([]);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView
        contentContainerStyle={styles.page}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
          />
        }>
        <View style={styles.header}>
          <Image source={require('../../../assets/emblem.png')} style={{ width: 54, height: 54 }} contentFit="contain" />
          <View style={{ flex: 1 }}>
            <Text style={[styles.brand, { color: t.cedre }]}>Igdad</Text>
            <Text style={{ color: t.mute, fontSize: 13 }}>Les oiseaux du Maroc, par le chant et par la photo</Text>
          </View>
          <Pressable
            onPress={() => router.push('/settings')}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Réglages"
            style={[styles.gear, { backgroundColor: t.card, borderColor: t.line }]}>
            <Ionicons name="settings-outline" size={22} color={t.cedre} />
          </Pressable>
        </View>

        <Text style={[styles.question, { color: t.text }]}>Comment voulez-vous reconnaître l'oiseau ?</Text>

        <Pressable
          onPress={() => router.navigate('/audio')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.choice, { backgroundColor: t.majorelle, opacity: pressed ? 0.88 : 1 }]}>
          <View style={[styles.choiceIcon, { backgroundColor: 'rgba(255,255,255,0.18)' }]}>
            <Ionicons name="mic" size={30} color={t.onMajorelle} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={[styles.choiceTitle, { color: t.onMajorelle }]}>Par le chant</Text>
            <Text style={[styles.choiceText, { color: t.onMajorelle }]}>
              Écoute en direct ou fichier audio. Plusieurs espèces peuvent être reconnues dans un même enregistrement.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color={t.onMajorelle} />
        </Pressable>

        <Pressable
          onPress={() => router.navigate('/image')}
          accessibilityRole="button"
          style={({ pressed }) => [styles.choice, { backgroundColor: t.safran, opacity: pressed ? 0.88 : 1 }]}>
          <View style={[styles.choiceIcon, { backgroundColor: 'rgba(28,36,33,0.10)' }]}>
            <Ionicons name="camera" size={30} color={t.onSafran} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={[styles.choiceTitle, { color: t.onSafran }]}>Par la photo</Text>
            <Text style={[styles.choiceText, { color: t.onSafran }]}>
              Caméra en direct ou photo de la galerie. Chaque oiseau est encadré et nommé.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={22} color={t.onSafran} />
        </Pressable>

        <View style={styles.stats}>
          {[
            [String(list.length), 'espèces'],
            [pct(threshold), 'seuil de confiance'],
            [tests ? String(tests.length) : '…', 'tests enregistrés'],
          ].map(([v, l]) => (
            <Card key={l} style={styles.stat}>
              <Text style={[styles.statValue, { color: t.cedre }]}>{v}</Text>
              <Text style={{ color: t.mute, fontSize: 12 }}>{l}</Text>
            </Card>
          ))}
        </View>

        <SectionTitle
          right={
            tests && tests.length > 0 ? (
              <Pressable onPress={() => router.push('/tests')} hitSlop={10}>
                <Text style={{ color: t.cedre, fontWeight: '600' }}>Tout voir</Text>
              </Pressable>
            ) : undefined
          }>
          Derniers tests enregistrés
        </SectionTitle>
        {tests === null ? null : tests.length === 0 ? (
          <Card>
            <Text style={{ color: t.mute, fontSize: 14, lineHeight: 20 }}>
              Aucun test pour l'instant. À la fin d'une écoute ou d'une analyse photo, choisissez « Enregistrer » pour le
              retrouver ici.
            </Text>
          </Card>
        ) : (
          tests.slice(0, 4).map((x) => (
            <Pressable key={x.id} onPress={() => router.push(`/test/${x.id}`)}>
              <Card style={styles.testRow}>
                <View style={[styles.testIcon, { backgroundColor: x.kind === 'audio' ? t.majorelleSoft : t.safranSoft }]}>
                  <Ionicons
                    name={x.kind === 'audio' ? 'mic' : 'camera'}
                    size={20}
                    color={x.kind === 'audio' ? t.majorelle : t.dark ? t.safran : '#C27A0E'}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: t.text, fontWeight: '600' }} numberOfLines={1}>
                    {x.detections.length
                      ? x.detections.map((d) => displayName(bySpecies[d.species], d.species)).join(', ')
                      : 'Aucune espèce au-dessus du seuil'}
                  </Text>
                  <Text style={{ color: t.mute, fontSize: 12 }}>
                    {new Date(x.saved).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })} · {x.source}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.mute} />
              </Card>
            </Pressable>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  gear: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 32, fontWeight: '800', letterSpacing: -1.2 },
  question: { fontSize: 22, fontWeight: '700', letterSpacing: -0.4, marginTop: 6 },
  choice: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 18, borderRadius: 22 },
  choiceIcon: { width: 58, height: 58, borderRadius: 29, alignItems: 'center', justifyContent: 'center' },
  choiceTitle: { fontSize: 21, fontWeight: '800', letterSpacing: -0.4 },
  choiceText: { fontSize: 14, lineHeight: 19, opacity: 0.92 },
  stats: { flexDirection: 'row', gap: 10 },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 12 },
  statValue: { fontSize: 22, fontWeight: '800', fontVariant: ['tabular-nums'] },
  testRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
  testIcon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
