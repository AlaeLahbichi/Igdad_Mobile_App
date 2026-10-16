import Ionicons from '@expo/vector-icons/Ionicons';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { Button, Card, ConfBar, SectionTitle } from '../components/ui';
import { api, pct } from '../lib/api';
import { useCatalog } from '../lib/catalog';
import { useTheme } from '../lib/theme';

const PRESETS = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95];
const MIN = 0.5;
const MAX = 0.99;

export default function Settings() {
  const t = useTheme();
  const { threshold, setThreshold, reload } = useCatalog();
  const [value, setValue] = useState(threshold);
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | string>('idle');
  const [address, setAddress] = useState(api.base);
  const [check, setCheck] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setValue(threshold), [threshold]);

  // enregistrement automatique 600 ms après le dernier changement
  function change(v: number) {
    const next = Math.round(Math.min(MAX, Math.max(MIN, v)) * 100) / 100;
    setValue(next);
    Haptics.selectionAsync().catch(() => {});
    if (timer.current) clearTimeout(timer.current);
    setState('saving');
    timer.current = setTimeout(async () => {
      try {
        await setThreshold(next);
        setState('saved');
      } catch (e: any) {
        setState(e.message);
      }
    }, 600);
  }

  const hint =
    value >= 0.9
      ? "Très strict : presque aucune erreur, mais certains oiseaux ne seront pas retenus."
      : value >= 0.75
        ? 'Équilibré : bon compromis entre fiabilité et nombre de détections.'
        : 'Permissif : plus de détections, mais davantage de confusions entre espèces proches.';

  return (
    <ScrollView contentContainerStyle={styles.page}>
      <SectionTitle>Seuil de confiance</SectionTitle>
      <Card style={{ gap: 14 }}>
        <Text style={{ color: t.mute, fontSize: 14, lineHeight: 20 }}>
          Une espèce n'est retenue (affichée, comptée dans Excel et le dashboard) que si le modèle en est sûr au moins à ce
          niveau. Le réglage s'applique au chant et à la photo.
        </Text>
        <View style={styles.stepper}>
          <Pressable
            onPress={() => change(value - 0.01)}
            disabled={value <= MIN}
            accessibilityLabel="Baisser le seuil"
            style={[styles.stepBtn, { backgroundColor: t.soft, opacity: value <= MIN ? 0.4 : 1 }]}>
            <Ionicons name="remove" size={26} color={t.text} />
          </Pressable>
          <View style={{ alignItems: 'center', flex: 1 }}>
            <Text style={[styles.value, { color: t.cedre }]}>{pct(value)}</Text>
            <Text style={{ color: t.mute, fontSize: 12 }}>
              {state === 'saving' ? 'Enregistrement…' : state === 'saved' ? 'Enregistré sur le serveur' : state === 'idle' ? ' ' : state}
            </Text>
          </View>
          <Pressable
            onPress={() => change(value + 0.01)}
            disabled={value >= MAX}
            accessibilityLabel="Augmenter le seuil"
            style={[styles.stepBtn, { backgroundColor: t.soft, opacity: value >= MAX ? 0.4 : 1 }]}>
            <Ionicons name="add" size={26} color={t.text} />
          </Pressable>
        </View>
        <ConfBar value={value} threshold={value} color={t.cedre} />
        <View style={styles.presets}>
          {PRESETS.map((p) => {
            const on = Math.abs(p - value) < 0.001;
            return (
              <Pressable
                key={p}
                onPress={() => change(p)}
                style={[styles.preset, { backgroundColor: on ? t.cedre : t.card, borderColor: on ? t.cedre : t.line }]}>
                <Text style={{ color: on ? t.onCedre : t.text, fontWeight: '700' }}>{pct(p)}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={[styles.hint, { backgroundColor: t.soft }]}>
          <Ionicons name="information-circle-outline" size={18} color={t.mute} />
          <Text style={{ color: t.text, fontSize: 13, flex: 1, lineHeight: 18 }}>{hint}</Text>
        </View>
      </Card>

      <SectionTitle>Serveur</SectionTitle>
      <Card style={{ gap: 10 }}>
        <Text style={{ color: t.mute, fontSize: 13 }}>
          Adresse du PC qui fait tourner les modèles. Le téléphone doit être sur le même Wi-Fi.
        </Text>
        <TextInput
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={[styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.bg }]}
        />
        <Button
          label="Tester la connexion"
          icon="wifi"
          variant="outline"
          onPress={async () => {
            api.setBase(address);
            setCheck('Connexion…');
            try {
              const h = await api.get<{ species: number; threshold: number }>('/api/m/health', 6000);
              setCheck(`Connecté : ${h.species} espèces, seuil ${pct(h.threshold)}.`);
              reload();
            } catch (e: any) {
              setCheck(e.message);
            }
          }}
        />
        {check && <Text style={{ color: t.mute, fontSize: 13 }}>{check}</Text>}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 40 },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  value: { fontSize: 48, fontWeight: '800', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  preset: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 99, borderWidth: 1 },
  hint: { flexDirection: 'row', gap: 8, padding: 10, borderRadius: 12, alignItems: 'flex-start' },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 15 },
});
