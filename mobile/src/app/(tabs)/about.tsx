import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Button, Card, SectionTitle } from '../../components/ui';
import { pct } from '../../lib/api';
import { useCatalog } from '../../lib/catalog';
import { useTheme } from '../../lib/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export default function About() {
  const t = useTheme();
  const { list, threshold } = useCatalog();

  const Item = ({ icon, color, title, text }: { icon: IconName; color: string; title: string; text: string }) => (
    <View style={styles.item}>
      <View style={[styles.itemIcon, { backgroundColor: t.soft }]}>
        <Ionicons name={icon} size={20} color={color} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={{ color: t.text, fontWeight: '700', fontSize: 15 }}>{title}</Text>
        <Text style={{ color: t.mute, fontSize: 14, lineHeight: 20 }}>{text}</Text>
      </View>
    </View>
  );

  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: t.bg }}>
      <ScrollView contentContainerStyle={styles.page}>
        <View style={{ alignItems: 'center', gap: 6 }}>
          <Image source={require('../../../assets/logo.png')} style={{ width: 150, height: 210 }} contentFit="contain" />
          <Text style={{ color: t.mute, fontSize: 14, textAlign: 'center' }}>
            Igdad (ⵉⴳⴹⴰⴹ) veut dire « les oiseaux » en tamazight.
          </Text>
        </View>

        <SectionTitle>Pourquoi Igdad ?</SectionTitle>
        <Text style={[styles.text, { color: t.text }]}>
          Le Maroc accueille des oiseaux qu'on ne voit nulle part ailleurs en Europe : alouettes du désert, Pie du Maghreb,
          Gobemouche de l'Atlas, Grand-duc ascalaphe… Ils sont souvent plus faciles à entendre qu'à voir. Igdad aide
          naturalistes, étudiants et curieux à les reconnaître sur le terrain, par leur chant ou sur une photo, puis à en
          apprendre davantage : description, habitat, zone d'observation, chant de référence.
        </Text>
        <Text style={[styles.text, { color: t.text }]}>
          Chaque détection est datée et comptée. Cela fait de l'app un petit outil de science participative : savoir quelles
          espèces sont observées, où et quand.
        </Text>

        <SectionTitle>Comment ça marche</SectionTitle>
        <Card style={{ gap: 14 }}>
          <Item
            icon="mic"
            color={t.majorelle}
            title="Par le chant"
            text="Le son est découpé en fenêtres de 5 s, transformées en spectrogrammes (mel, 32 kHz). Un réseau EfficientNet-B0 reconnaît l'espèce dans chaque fenêtre. Plusieurs espèces peuvent donc ressortir d'un même enregistrement. Précision au niveau de l'enregistrement : 88,6 % (jeu de test)."
          />
          <Item
            icon="camera"
            color={t.dark ? t.safran : '#C27A0E'}
            title="Par la photo"
            text="Un détecteur YOLO11s, entraîné sur 11 779 photos, encadre chaque oiseau et donne son espèce. Sur le jeu de test : mAP50 de 79,4 %, précision de 80,3 %."
          />
          <Item
            icon="shield-checkmark"
            color={t.oasis}
            title={`Seuil de ${pct(threshold)}`}
            text={`Une espèce n'est affichée que si le modèle en est sûr à au moins ${pct(threshold)}. Les hypothèses plus faibles sont signalées sans être retenues.`}
          />
          <Item
            icon="document-text"
            color={t.cedre}
            title="Journal CSV + Excel"
            text="Chaque espèce détectée ajoute une ligne (date, mode, espèce, confiance) à detections.csv et detections.xlsx sur le PC. Une feuille « Compteur » fait le total par espèce."
          />
          <Item
            icon="save"
            color={t.cedre}
            title="Tests enregistrés"
            text="À la fin d'une écoute ou d'une analyse, vous choisissez de garder ou non l'audio (ou la photo) avec ses détections."
          />
        </Card>

        <SectionTitle>Les données</SectionTitle>
        <Card style={{ gap: 14 }}>
          <Item icon="musical-notes" color={t.majorelle} title="Xeno-Canto" text="15 389 enregistrements (Maroc, Espagne, Portugal, Algérie), qualité A à C, et 485 553 métadonnées analysées avec Spark." />
          <Item icon="leaf" color={t.oasis} title="iNaturalist" text="15 853 photos d'observations validées (« research grade »), sous licences Creative Commons." />
          <Item icon="book" color={t.cedre} title="Wikipédia" text="Descriptions, habitat et répartition des espèces (licence CC BY-SA)." />
          <Item
            icon="server"
            color={t.terre}
            title="Data lake TAGHRID"
            text={`Les données passent par trois couches dans MinIO : bronze (brut), silver (nettoyé) et gold (prêt à l'emploi). Le catalogue des ${list.length} espèces de l'app est construit avec PySpark dans la couche gold.`}
          />
        </Card>

        <Button label="Réglages (seuil, serveur)" icon="settings-outline" variant="outline" onPress={() => router.push('/settings')} />

        <Text style={{ color: t.mute, fontSize: 12, textAlign: 'center', marginTop: 8 }}>
          Projet Ecosystem Big Data · EMSI · 2026
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 16, gap: 14, paddingBottom: 32 },
  text: { fontSize: 15, lineHeight: 23 },
  item: { flexDirection: 'row', gap: 12 },
  itemIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
});
