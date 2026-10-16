import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Circle } from 'react-native-maps';

import { AudioPlayerRow, Button, Card, Chip, Loader, Notice, SectionTitle } from '../../components/ui';
import { api, SpeciesDetail } from '../../lib/api';
import { IUCN_COLORS, useTheme } from '../../lib/theme';

const SECTIONS: [string, string][] = [
  ['description', 'Description'],
  ['voix', 'Chant et cris'],
  ['habitat', 'Habitat'],
  ['repartition', 'Répartition'],
  ['alimentation', 'Alimentation'],
  ['reproduction', 'Reproduction'],
  ['comportement', 'Comportement'],
];
const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
const LICENSES: Record<string, string> = {
  cc0: 'CC0',
  'cc-by': 'CC BY',
  'cc-by-sa': 'CC BY-SA',
  'cc-by-nc': 'CC BY-NC',
  'cc-by-nc-sa': 'CC BY-NC-SA',
  'cc-by-nc-nd': 'CC BY-NC-ND',
};

export default function SpeciesScreen() {
  const t = useTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [sp, setSp] = useState<SpeciesDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<SpeciesDetail>(`/api/m/species/${id}`)
      .then(setSp)
      .catch((e) => setError(e.message));
  }, [id]);

  if (error) return <View style={{ padding: 16 }}><Notice icon="alert-circle" color={t.terre} text={error} /></View>;
  if (!sp) return <Loader full label="Chargement de la fiche…" />;

  const name = sp.fr || sp.en || sp.sci;
  const wiki = sp.wiki;
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
      <Stack.Screen options={{ title: name }} />
      <Image source={{ uri: api.photo(sp.species, 1000) }} style={styles.hero} contentFit="cover" transition={250} />
      <Text style={[styles.credit, { color: t.mute }]}>Photo : {sp.photo_attribution}</Text>

      <View style={styles.body}>
        <View style={{ gap: 4 }}>
          <Text style={[styles.name, { color: t.text }]}>{name}</Text>
          <Text style={[styles.sci, { color: t.mute }]}>
            {sp.sci}
            {sp.en ? `  ·  ${sp.en}` : ''}
          </Text>
        </View>
        <View style={styles.chips}>
          <Chip label={`UICN ${sp.iucn} · ${sp.iucn_label}`} color={IUCN_COLORS[sp.iucn] || '#6B7280'} />
          {sp.family && <Chip label={sp.family_fr ? `${sp.family_fr} (${sp.family})` : sp.family} color={t.soft} textColor={t.text} />}
          {sp.order_fr && <Chip label={sp.order_fr} color={t.soft} textColor={t.text} />}
        </View>

        {sp.songs.length > 0 && (
          <>
            <SectionTitle>Écouter</SectionTitle>
            {sp.songs.map((s) => (
              <AudioPlayerRow
                key={s.kind}
                uri={api.song(sp.species, s.kind)}
                color={t.majorelle}
                title={s.kind === 'chant' ? 'Chant' : 'Cri'}
                subtitle={`${s.locality}, ${s.country === 'Morocco' ? 'Maroc' : s.country} · ${s.recordist} · XC${s.recording_id}`}
              />
            ))}
          </>
        )}

        <SectionTitle>Zone d'observation</SectionTitle>
        <RangeMap sp={sp} />

        {wiki && (
          <>
            {sp.note && <Notice icon="information-circle-outline" color={t.safran} text={sp.note} />}
            <Text style={[styles.text, { color: t.text }]}>{wiki.intro}</Text>
            {SECTIONS.filter(([k]) => wiki[k]).map(([k, label]) => (
              <View key={k} style={{ gap: 6 }}>
                <Text style={[styles.h3, { color: t.cedre }]}>{label}</Text>
                <Text style={[styles.text, { color: t.text }]}>{wiki[k]}</Text>
              </View>
            ))}
          </>
        )}

        <SectionTitle>Présence au Maroc</SectionTitle>
        <Seasonality months={sp.months_morocco} />

        <View style={styles.statsRow}>
          {[
            [sp.stats.xc_recordings, 'enregistrements Xeno-Canto'],
            [sp.stats.xc_morocco, 'au Maroc'],
            [sp.stats.inat_photos, 'photos iNaturalist'],
          ].map(([v, l]) => (
            <Card key={String(l)} style={styles.stat}>
              <Text style={[styles.statValue, { color: t.cedre }]}>{Number(v).toLocaleString('fr-FR')}</Text>
              <Text style={{ color: t.mute, fontSize: 11, textAlign: 'center' }}>{l}</Text>
            </Card>
          ))}
        </View>

        {sp.gallery.length > 0 && (
          <>
            <SectionTitle>Photos</SectionTitle>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10 }}>
              {sp.gallery.map((g, i) => (
                <Pressable key={i} onPress={() => Linking.openURL(g.source_url)} style={{ width: 220, gap: 4 }}>
                  <Image source={{ uri: api.gallery(sp.species, i, 600) }} style={styles.gal} contentFit="cover" transition={150} />
                  <Text style={{ color: t.mute, fontSize: 11 }} numberOfLines={2}>
                    {g.place_guess ? `${g.place_guess} · ` : ''}
                    {g.attribution}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </>
        )}

        <SectionTitle>Sources</SectionTitle>
        <Card style={{ gap: 10 }}>
          {wiki && (
            <Button label={`Wikipédia : ${wiki.title}`} icon="book-outline" variant="ghost" color={t.cedre} onPress={() => Linking.openURL(wiki.url)} style={styles.link} />
          )}
          <Button label="Fiche iNaturalist" icon="leaf-outline" variant="ghost" color={t.cedre} onPress={() => Linking.openURL(`https://www.inaturalist.org/taxa/${sp.inat_id}`)} style={styles.link} />
          {sp.songs.map((s) => (
            <Button key={s.kind} label={`Xeno-Canto XC${s.recording_id} (${LICENSES['cc-' + s.license] || s.license})`} icon="musical-note-outline" variant="ghost" color={t.cedre} onPress={() => Linking.openURL(s.source_url)} style={styles.link} />
          ))}
          <Text style={{ color: t.mute, fontSize: 12, lineHeight: 17 }}>
            Textes : Wikipédia ({wiki?.lang === 'fr' ? 'français' : 'anglais'}), licence CC BY-SA. Photo principale :{' '}
            {LICENSES[sp.photo_license || ''] || sp.photo_license}. Statut UICN et taxonomie : iNaturalist.
          </Text>
        </Card>
      </View>
    </ScrollView>
  );
}

function RangeMap({ sp }: { sp: SpeciesDetail }) {
  const t = useTheme();
  const cells = sp.range.cells;
  const region = useMemo(() => {
    // cadrage sur l'aire d'étude (Maroc, péninsule Ibérique, Algérie) quand l'espèce y est observée
    const local = cells.filter(([la, lo]) => la > 18 && la < 45 && lo > -20 && lo < 12);
    const pts = local.length >= 3 ? local : cells;
    if (!pts.length) return { latitude: 31.8, longitude: -7.1, latitudeDelta: 12, longitudeDelta: 12 };
    const lats = pts.map((c) => c[0]);
    const lons = pts.map((c) => c[1]);
    const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    return {
      latitude: (a + b) / 2,
      longitude: (c + d) / 2,
      latitudeDelta: Math.min(70, Math.max(6, (b - a) * 1.35)),
      longitudeDelta: Math.min(120, Math.max(6, (d - c) * 1.35)),
    };
  }, [cells]);
  const max = Math.max(1, ...cells.map((c) => c[2]));
  const shown = cells.slice(0, 350);
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.map, { borderColor: t.line }]}>
        <MapView style={StyleSheet.absoluteFill} initialRegion={region} mapType="mutedStandard" rotateEnabled={false} pitchEnabled={false}>
          {shown.map(([lat, lon, n], i) => {
            const k = Math.sqrt(n / max);
            return (
              <Circle
                key={i}
                center={{ latitude: lat, longitude: lon }}
                radius={16000 + 22000 * k}
                fillColor={t.dark ? `rgba(79,179,148,${0.25 + 0.55 * k})` : `rgba(31,94,75,${0.22 + 0.55 * k})`}
                strokeColor="rgba(0,0,0,0)"
                strokeWidth={0}
              />
            );
          })}
        </MapView>
      </View>
      <Text style={{ color: t.mute, fontSize: 12, lineHeight: 17 }}>
        Chaque disque = une zone de 0,5° × 0,5° où l'espèce a été enregistrée (Xeno-Canto) ou photographiée (iNaturalist).
        Plus il est foncé, plus les observations y sont nombreuses. {cells.length} zones.
      </Text>
    </View>
  );
}

function Seasonality({ months }: { months: number[] }) {
  const t = useTheme();
  const max = Math.max(1, ...months);
  const total = months.reduce((a, b) => a + b, 0);
  return (
    <Card style={{ gap: 8 }}>
      <View style={styles.season}>
        {months.map((m, i) => (
          <View key={i} style={{ flex: 1, alignItems: 'center', gap: 4 }}>
            <View style={{ flex: 1, width: '70%', justifyContent: 'flex-end' }}>
              <View style={{ height: `${(m / max) * 100}%`, minHeight: m ? 3 : 0, backgroundColor: t.cedre, borderRadius: 3 }} />
            </View>
            <Text style={{ color: t.mute, fontSize: 11 }}>{MONTHS[i]}</Text>
          </View>
        ))}
      </View>
      <Text style={{ color: t.mute, fontSize: 12 }}>
        {total
          ? `Enregistrements Xeno-Canto au Maroc par mois (${total} au total).`
          : 'Aucun enregistrement daté au Maroc dans Xeno-Canto.'}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  hero: { width: '100%', aspectRatio: 4 / 3 },
  credit: { fontSize: 11, paddingHorizontal: 16, paddingTop: 4 },
  body: { padding: 16, gap: 14 },
  name: { fontSize: 30, fontWeight: '800', letterSpacing: -0.8 },
  sci: { fontSize: 15, fontStyle: 'italic' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  h3: { fontSize: 16, fontWeight: '700' },
  text: { fontSize: 15, lineHeight: 23 },
  map: { height: 280, borderRadius: 18, overflow: 'hidden', borderWidth: 1 },
  season: { flexDirection: 'row', height: 110, gap: 2 },
  statsRow: { flexDirection: 'row', gap: 8 },
  stat: { flex: 1, alignItems: 'center', paddingVertical: 10, paddingHorizontal: 6 },
  statValue: { fontSize: 19, fontWeight: '800', fontVariant: ['tabular-nums'] },
  gal: { width: 220, height: 160, borderRadius: 14 },
  link: { justifyContent: 'flex-start', paddingVertical: 4, paddingHorizontal: 0 },
});
