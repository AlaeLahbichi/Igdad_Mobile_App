import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Chip } from '../../components/ui';
import { api, Species } from '../../lib/api';
import { displayName, useCatalog } from '../../lib/catalog';
import { IUCN_COLORS, useTheme } from '../../lib/theme';

type Sort = 'fr' | 'sci' | 'family' | 'iucn';
const SORTS: { value: Sort; label: string }[] = [
  { value: 'fr', label: 'Nom A → Z' },
  { value: 'sci', label: 'Nom scientifique' },
  { value: 'family', label: 'Famille' },
  { value: 'iucn', label: 'Statut UICN' },
];
const IUCN_ORDER = ['CR', 'EN', 'VU', 'NT', 'LC', 'DD', 'NE'];

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const collator = new Intl.Collator('fr', { sensitivity: 'base' });

export default function Birds() {
  const t = useTheme();
  const { list } = useCatalog();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('fr');

  const data = useMemo(() => {
    const q = norm(query.trim());
    const rows = list.filter(
      (s) => !q || [s.fr, s.en, s.sci, s.family, s.family_fr].some((v) => v && norm(v).includes(q)),
    );
    const by: Record<Sort, (a: Species, b: Species) => number> = {
      fr: (a, b) => collator.compare(displayName(a), displayName(b)),
      sci: (a, b) => collator.compare(a.sci, b.sci),
      family: (a, b) => collator.compare(a.family || '', b.family || '') || collator.compare(displayName(a), displayName(b)),
      iucn: (a, b) => IUCN_ORDER.indexOf(a.iucn) - IUCN_ORDER.indexOf(b.iucn) || collator.compare(displayName(a), displayName(b)),
    };
    return [...rows].sort(by[sort]);
  }, [list, query, sort]);

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <FlatList
        data={data}
        keyExtractor={(s) => s.species}
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 4 }}>
            <Text style={[styles.title, { color: t.text }]}>Les 83 oiseaux</Text>
            <View style={[styles.search, { backgroundColor: t.card, borderColor: t.line }]}>
              <Ionicons name="search" size={18} color={t.mute} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Rechercher (nom, famille…)"
                placeholderTextColor={t.mute}
                style={{ flex: 1, color: t.text, fontSize: 16, paddingVertical: 10 }}
                autoCorrect={false}
                clearButtonMode="while-editing"
              />
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {SORTS.map((o) => {
                const on = o.value === sort;
                return (
                  <Pressable
                    key={o.value}
                    onPress={() => setSort(o.value)}
                    style={[styles.sortChip, { backgroundColor: on ? t.cedre : t.card, borderColor: on ? t.cedre : t.line }]}>
                    <Text style={{ color: on ? t.onCedre : t.text, fontWeight: '600', fontSize: 13 }}>{o.label}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Text style={{ color: t.mute, fontSize: 13 }}>{data.length} espèce{data.length > 1 ? 's' : ''}</Text>
          </View>
        }
        renderItem={({ item: s, index }) => {
          const header =
            sort === 'family' && (index === 0 || data[index - 1].family !== s.family)
              ? s.family_fr
                ? `${s.family_fr} · ${s.family}`
                : s.family
              : null;
          return (
            <View>
              {header && <Text style={[styles.group, { color: t.cedre }]}>{header}</Text>}
              <Pressable
                onPress={() => router.push(`/species/${s.species}`)}
                style={({ pressed }) => [styles.row, { backgroundColor: t.card, borderColor: t.line, opacity: pressed ? 0.8 : 1 }]}>
                <Image source={{ uri: api.photo(s.species, 200) }} style={styles.thumb} contentFit="cover" transition={150} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={[styles.name, { color: t.text }]} numberOfLines={1}>
                    {displayName(s)}
                  </Text>
                  <Text style={{ color: t.mute, fontSize: 13, fontStyle: 'italic' }} numberOfLines={1}>
                    {s.sci}
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', marginTop: 3 }}>
                    <Chip label={s.iucn} color={IUCN_COLORS[s.iucn] || '#6B7280'} />
                    <Text style={{ color: t.mute, fontSize: 12, flex: 1 }} numberOfLines={1}>
                      {s.family_fr || s.family}
                    </Text>
                    {s.has_song && <Ionicons name="musical-notes" size={15} color={t.majorelle} />}
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={18} color={t.mute} />
              </Pressable>
            </View>
          );
        }}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={<Text style={{ color: t.mute, textAlign: 'center', marginTop: 30 }}>Aucune espèce ne correspond.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderRadius: 14, paddingHorizontal: 12 },
  sortChip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, borderWidth: 1 },
  group: { fontSize: 13, fontWeight: '700', marginTop: 10, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: 16, borderWidth: 1 },
  thumb: { width: 64, height: 64, borderRadius: 12 },
  name: { fontSize: 16, fontWeight: '700' },
});
