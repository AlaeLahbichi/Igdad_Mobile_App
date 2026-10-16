import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useFocusEffect } from 'expo-router';
import { ReactNode, useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { SafeAreaView } from 'react-native-safe-area-context';
import Svg, { Circle, G, Line, Rect, Text as SvgText } from 'react-native-svg';

import { Card, Loader, Notice, SectionTitle } from '../../components/ui';
import { api } from '../../lib/api';
import { displayName, useCatalog } from '../../lib/catalog';
import { IUCN_COLORS, Theme, useTheme } from '../../lib/theme';

type Dashboard = {
  total: number;
  sessions: number;
  species_detected: number;
  species_total: number;
  avg_conf: number | null;
  modes: { audio?: number; image?: number };
  sources: Record<string, number>;
  by_day: { date: string; audio: number; image: number }[];
  by_hour: number[];
  conf_bins: number[];
  conf_labels: string[];
  families: { family: string; count: number }[];
  iucn: Record<string, number>;
  top: { species: string; fr: string; sci: string; count: number; audio: number; image: number; last: string }[];
  points: { lat: number; lon: number; species: string; mode: 'audio' | 'image'; conf: number; when: string }[];
  recent: { species: string; mode: 'audio' | 'image'; source: string; conf: number; when: string }[];
  files: { journal: string; compteur: string };
};

export default function DashboardScreen() {
  const t = useTheme();
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [width, setWidth] = useState(0);

  const load = useCallback(async () => {
    try {
      setData(await api.get<Dashboard>('/api/m/dashboard'));
      setError(null);
    } catch (e: any) {
      setError(e.message);
    }
  }, []);

  // rafraîchi à l'ouverture de l'onglet puis toutes les 10 s tant qu'il est affiché
  useFocusEffect(
    useCallback(() => {
      load();
      const id = setInterval(load, 10000);
      return () => clearInterval(id);
    }, [load]),
  );

  if (!data && !error) return <Loader full label="Calcul des statistiques…" />;
  const imageColor = t.dark ? t.safran : '#D9901F';
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
        <View onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
          <Text style={[styles.title, { color: t.text }]}>Tableau de bord</Text>
          <Text style={{ color: t.mute, fontSize: 14 }}>Toutes vos détections, mises à jour en direct.</Text>
        </View>
        {error && <Notice icon="alert-circle" color={t.terre} text={error} />}
        {data && data.total === 0 && (
          <Notice icon="analytics-outline" text="Aucune détection pour l'instant. Lancez une écoute ou une analyse photo : les statistiques apparaîtront ici." />
        )}
        {data && width > 0 && (
          <>
            <View style={styles.kpis}>
              <Kpi t={t} icon="pulse" color={t.cedre} value={String(data.total)} label="détections" />
              <Kpi
                t={t}
                icon="leaf"
                color={t.oasis}
                value={`${data.species_detected}/${data.species_total}`}
                label="espèces vues"
                progress={data.species_detected / data.species_total}
              />
              <Kpi t={t} icon="shield-checkmark" color={t.majorelle} value={data.avg_conf ? `${data.avg_conf} %` : '–'} label="confiance moyenne" />
              <Kpi t={t} icon="albums" color={imageColor} value={String(data.sessions)} label="sessions" />
            </View>

            <SectionTitle>Chant ou photo</SectionTitle>
            <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 18 }}>
              <Donut
                t={t}
                size={128}
                parts={[
                  { value: data.modes.audio || 0, color: t.majorelle },
                  { value: data.modes.image || 0, color: imageColor },
                ]}
                center={String(data.total)}
              />
              <View style={{ flex: 1, gap: 10 }}>
                <Legend color={t.majorelle} label="Chant (audio)" value={data.modes.audio || 0} t={t} />
                <Legend color={imageColor} label="Photo (image)" value={data.modes.image || 0} t={t} />
                <View style={{ height: 1, backgroundColor: t.line }} />
                {Object.entries(data.sources).map(([k, v]) => (
                  <Legend key={k} color={t.mute} label={k} value={v} t={t} small />
                ))}
              </View>
            </Card>

            <SectionTitle>14 derniers jours</SectionTitle>
            <Card>
              <DaysChart t={t} width={width - 30} days={data.by_day} audioColor={t.majorelle} imageColor={imageColor} />
            </Card>

            <SectionTitle>Espèces les plus détectées</SectionTitle>
            <Card style={{ gap: 10 }}>
              {data.top.length === 0 && <Text style={{ color: t.mute }}>Rien pour l'instant.</Text>}
              {data.top.slice(0, 10).map((s) => (
                <TopRow key={s.species} t={t} s={s} max={data.top[0].count} audioColor={t.majorelle} imageColor={imageColor} />
              ))}
            </Card>

            <SectionTitle>Carte des détections</SectionTitle>
            <DetectionsMap t={t} points={data.points} audioColor={t.majorelle} imageColor={imageColor} />

            <SectionTitle>Heures d'activité</SectionTitle>
            <Card>
              <HoursChart t={t} width={width - 30} hours={data.by_hour} />
            </Card>

            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Card style={{ flex: 1, gap: 8 }}>
                <Text style={[styles.cardTitle, { color: t.text }]}>Confiance</Text>
                <MiniBars
                  t={t}
                  values={data.conf_bins}
                  labels={data.conf_labels}
                  color={t.oasis}
                  width={(width - 10) / 2 - 30}
                />
              </Card>
              <Card style={{ flex: 1, gap: 8 }}>
                <Text style={[styles.cardTitle, { color: t.text }]}>Statut UICN</Text>
                {Object.keys(data.iucn).length === 0 && <Text style={{ color: t.mute, fontSize: 13 }}>–</Text>}
                {Object.entries(data.iucn).map(([k, v]) => (
                  <Legend key={k} color={IUCN_COLORS[k] || t.mute} label={k} value={v} t={t} small />
                ))}
              </Card>
            </View>

            {data.families.length > 0 && (
              <>
                <SectionTitle>Familles</SectionTitle>
                <Card style={{ gap: 8 }}>
                  {data.families.map((f) => (
                    <HBar key={f.family} t={t} label={f.family} value={f.count} max={data.families[0].count} color={t.cedre} />
                  ))}
                </Card>
              </>
            )}

            {data.recent.length > 0 && (
              <>
                <SectionTitle>Dernières détections</SectionTitle>
                <Card style={{ gap: 2 }}>
                  {data.recent.map((r, i) => (
                    <RecentRow key={i} t={t} r={r} audioColor={t.majorelle} imageColor={imageColor} />
                  ))}
                </Card>
              </>
            )}

            <Notice
              icon="document-text-outline"
              text={`Sur le PC : ${data.files.compteur} (compteur par espèce) et ${data.files.journal} (journal détaillé).`}
            />
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------- éléments
function Kpi({ t, icon, color, value, label, progress }: { t: Theme; icon: keyof typeof Ionicons.glyphMap; color: string; value: string; label: string; progress?: number }) {
  return (
    <Card style={styles.kpi}>
      <View style={[styles.kpiIcon, { backgroundColor: t.soft }]}>
        <Ionicons name={icon} size={18} color={color} />
      </View>
      <Text style={[styles.kpiValue, { color: t.text }]}>{value}</Text>
      <Text style={{ color: t.mute, fontSize: 12 }}>{label}</Text>
      {progress !== undefined && (
        <View style={[styles.track, { backgroundColor: t.soft }]}>
          <View style={{ width: `${Math.round(progress * 100)}%`, height: '100%', backgroundColor: color, borderRadius: 99 }} />
        </View>
      )}
    </Card>
  );
}

function Legend({ color, label, value, t, small }: { color: string; label: string; value: number; t: Theme; small?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
      <Text style={{ flex: 1, color: small ? t.mute : t.text, fontSize: small ? 13 : 14 }}>{label}</Text>
      <Text style={{ color: t.text, fontWeight: '700', fontVariant: ['tabular-nums'] }}>{value}</Text>
    </View>
  );
}

function Donut({ t, size, parts, center }: { t: Theme; size: number; parts: { value: number; color: string }[]; center: string }) {
  const r = size / 2 - 12;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((a, p) => a + p.value, 0);
  let offset = 0;
  return (
    <Svg width={size} height={size}>
      <G rotation={-90} origin={`${size / 2}, ${size / 2}`}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={t.soft} strokeWidth={18} fill="none" />
        {total > 0 &&
          parts.map((p, i) => {
            const len = (p.value / total) * c;
            const el = (
              <Circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                stroke={p.color}
                strokeWidth={18}
                fill="none"
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-offset}
              />
            );
            offset += len;
            return el;
          })}
      </G>
      <SvgText x={size / 2} y={size / 2 + 8} textAnchor="middle" fontSize={24} fontWeight="800" fill={t.text}>
        {center}
      </SvgText>
    </Svg>
  );
}

function DaysChart({ t, width, days, audioColor, imageColor }: { t: Theme; width: number; days: Dashboard['by_day']; audioColor: string; imageColor: string }) {
  const h = 150;
  const pad = { l: 24, b: 22, t: 8 };
  const max = Math.max(1, ...days.map((d) => d.audio + d.image));
  const bw = (width - pad.l) / days.length;
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const ticks = Array.from(new Set([0, Math.ceil(max / 2), max]));
  return (
    <View style={{ gap: 8 }}>
      <Svg width={width} height={h}>
        {ticks.map((v) => (
          <G key={v}>
            <Line x1={pad.l} x2={width} y1={y(v)} y2={y(v)} stroke={t.line} strokeWidth={1} />
            <SvgText x={pad.l - 6} y={y(v) + 4} fontSize={10} fill={t.mute} textAnchor="end">
              {v}
            </SvgText>
          </G>
        ))}
        {days.map((d, i) => {
          const x = pad.l + i * bw + bw * 0.18;
          const w = bw * 0.64;
          const ya = y(d.audio);
          const yi = y(d.audio + d.image);
          return (
            <G key={d.date}>
              {d.audio > 0 && <Rect x={x} y={ya} width={w} height={y(0) - ya} fill={audioColor} rx={2} />}
              {d.image > 0 && <Rect x={x} y={yi} width={w} height={ya - yi} fill={imageColor} rx={2} />}
              {(i % 2 === 1 || i === days.length - 1) && (
                <SvgText x={x + w / 2} y={h - 6} fontSize={9} fill={t.mute} textAnchor="middle">
                  {d.date.slice(8, 10)}/{d.date.slice(5, 7)}
                </SvgText>
              )}
            </G>
          );
        })}
      </Svg>
      <View style={{ flexDirection: 'row', gap: 16 }}>
        <Legend color={audioColor} label="Chant" value={days.reduce((a, d) => a + d.audio, 0)} t={t} small />
        <Legend color={imageColor} label="Photo" value={days.reduce((a, d) => a + d.image, 0)} t={t} small />
      </View>
    </View>
  );
}

function HoursChart({ t, width, hours }: { t: Theme; width: number; hours: number[] }) {
  const h = 110;
  const max = Math.max(1, ...hours);
  const bw = width / 24;
  return (
    <Svg width={width} height={h}>
      {hours.map((v, i) => {
        const bh = (h - 20) * (v / max);
        return (
          <G key={i}>
            <Rect x={i * bw + 1.5} y={h - 18 - bh} width={bw - 3} height={Math.max(bh, v ? 2 : 0)} fill={t.cedre} rx={2} />
            {i % 3 === 0 && (
              <SvgText x={i * bw + bw / 2} y={h - 4} fontSize={9} fill={t.mute} textAnchor="middle">
                {`${i}h`}
              </SvgText>
            )}
          </G>
        );
      })}
      <Line x1={0} x2={width} y1={h - 18} y2={h - 18} stroke={t.line} strokeWidth={1} />
    </Svg>
  );
}

function MiniBars({ t, values, labels, color, width }: { t: Theme; values: number[]; labels: string[]; color: string; width: number }) {
  const h = 90;
  const max = Math.max(1, ...values);
  const bw = width / values.length;
  return (
    <Svg width={width} height={h}>
      {values.map((v, i) => {
        const bh = (h - 32) * (v / max);
        return (
          <G key={i}>
            <Rect x={i * bw + 4} y={h - 18 - bh} width={bw - 8} height={Math.max(bh, v ? 2 : 0)} fill={color} rx={3} />
            <SvgText x={i * bw + bw / 2} y={h - 22 - bh} fontSize={10} fill={t.text} textAnchor="middle" fontWeight="700">
              {v ? String(v) : ''}
            </SvgText>
            <SvgText x={i * bw + bw / 2} y={h - 4} fontSize={9} fill={t.mute} textAnchor="middle">
              {labels[i]}
            </SvgText>
          </G>
        );
      })}
    </Svg>
  );
}

function HBar({ t, label, value, max, color }: { t: Theme; label: string; value: number; max: number; color: string }) {
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text style={{ color: t.text, fontSize: 13 }} numberOfLines={1}>
          {label}
        </Text>
        <Text style={{ color: t.text, fontSize: 13, fontWeight: '700' }}>{value}</Text>
      </View>
      <View style={[styles.track, { backgroundColor: t.soft }]}>
        <View style={{ width: `${(value / max) * 100}%`, height: '100%', backgroundColor: color, borderRadius: 99 }} />
      </View>
    </View>
  );
}

function TopRow({ t, s, max, audioColor, imageColor }: { t: Theme; s: Dashboard['top'][number]; max: number; audioColor: string; imageColor: string }) {
  return (
    <Pressable onPress={() => router.push(`/species/${s.species}`)} style={{ flexDirection: 'row', gap: 10, alignItems: 'center' }}>
      <Image source={{ uri: api.photo(s.species, 120) }} style={{ width: 40, height: 40, borderRadius: 10 }} contentFit="cover" />
      <View style={{ flex: 1, gap: 4 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Text style={{ color: t.text, fontWeight: '600', flex: 1 }} numberOfLines={1}>
            {s.fr || s.sci}
          </Text>
          <Text style={{ color: t.text, fontWeight: '800', fontVariant: ['tabular-nums'] }}>{s.count}</Text>
        </View>
        <View style={[styles.track, { backgroundColor: t.soft, flexDirection: 'row' }]}>
          <View style={{ width: `${(s.audio / max) * 100}%`, backgroundColor: audioColor }} />
          <View style={{ width: `${(s.image / max) * 100}%`, backgroundColor: imageColor }} />
        </View>
      </View>
    </Pressable>
  );
}

function RecentRow({ t, r, audioColor, imageColor }: { t: Theme; r: Dashboard['recent'][number]; audioColor: string; imageColor: string }) {
  const { bySpecies } = useCatalog();
  return (
    <Pressable onPress={() => r.species && router.push(`/species/${r.species}`)} style={styles.recent}>
      <Ionicons name={r.mode === 'audio' ? 'mic' : 'camera'} size={16} color={r.mode === 'audio' ? audioColor : imageColor} />
      <Text style={{ flex: 1, color: t.text, fontSize: 14 }} numberOfLines={1}>
        {displayName(bySpecies[r.species], r.species)}
      </Text>
      <Text style={{ color: t.mute, fontSize: 12, fontVariant: ['tabular-nums'] }}>
        {Math.round(r.conf)} % · {r.when.slice(5, 16).replace('-', '/')}
      </Text>
    </Pressable>
  );
}

function DetectionsMap({ t, points, audioColor, imageColor }: { t: Theme; points: Dashboard['points']; audioColor: string; imageColor: string }) {
  const { bySpecies } = useCatalog();
  const region = useMemo(() => {
    if (!points.length) return { latitude: 31.8, longitude: -7.1, latitudeDelta: 11, longitudeDelta: 11 };
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const [a, b, c, d] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
    return {
      latitude: (a + b) / 2,
      longitude: (c + d) / 2,
      latitudeDelta: Math.max(0.05, (b - a) * 1.6),
      longitudeDelta: Math.max(0.05, (d - c) * 1.6),
    };
  }, [points]);
  return (
    <View style={{ gap: 6 }}>
      <View style={[styles.map, { borderColor: t.line }]}>
        <MapView style={StyleSheet.absoluteFill} region={region} mapType="mutedStandard" showsUserLocation>
          {points.map((p, i) => (
            <Marker
              key={`${p.when}-${i}`}
              coordinate={{ latitude: p.lat, longitude: p.lon }}
              pinColor={p.mode === 'audio' ? audioColor : imageColor}
              title={displayName(bySpecies[p.species], p.species)}
              description={`${p.mode === 'audio' ? 'Chant' : 'Photo'} · ${Math.round(p.conf)} % · ${p.when}`}
            />
          ))}
        </MapView>
      </View>
      <Text style={{ color: t.mute, fontSize: 12, lineHeight: 17 }}>
        {points.length
          ? `${points.length} détection${points.length > 1 ? 's' : ''} localisée${points.length > 1 ? 's' : ''}. Épingle violette : chant, orange : photo. Touchez une épingle pour voir l'espèce.`
          : "Aucune détection localisée pour l'instant. Autorisez la localisation : chaque nouvelle détection apparaîtra sur la carte."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  title: { fontSize: 26, fontWeight: '800', letterSpacing: -0.6 },
  kpis: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  kpi: { width: '48%', flexGrow: 1, gap: 4 },
  kpiIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 4 },
  kpiValue: { fontSize: 26, fontWeight: '800', letterSpacing: -0.5, fontVariant: ['tabular-nums'] },
  track: { height: 8, borderRadius: 99, overflow: 'hidden', marginTop: 4 },
  cardTitle: { fontSize: 15, fontWeight: '700' },
  map: { height: 300, borderRadius: 18, overflow: 'hidden', borderWidth: 1 },
  recent: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8 },
});
