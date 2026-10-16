import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { Button, Loader } from '../components/ui';
import { api } from '../lib/api';
import { CatalogProvider, useCatalog } from '../lib/catalog';
import { useTheme } from '../lib/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

function Gate() {
  const t = useTheme();
  const { status, error, reload } = useCatalog();
  const [address, setAddress] = useState(api.base);

  useEffect(() => {
    // l'écran de démarrage natif laisse la place à l'animation de chargement d'Igdad
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  if (status === 'loading') return <Loader full label="Chargement des 83 espèces…" />;
  if (status === 'error')
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.error}>
          <Text style={[styles.brand, { color: t.cedre }]}>Igdad</Text>
          <Text style={[styles.title, { color: t.text }]}>Connexion au serveur impossible</Text>
          <Text style={{ color: t.mute, fontSize: 15, lineHeight: 21 }}>{error}</Text>
          <Text style={{ color: t.mute, fontSize: 14 }}>Adresse du serveur Igdad (PC) :</Text>
          <TextInput
            value={address}
            onChangeText={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={[styles.input, { borderColor: t.line, color: t.text, backgroundColor: t.card }]}
          />
          <Button
            label="Réessayer"
            icon="refresh"
            onPress={() => {
              api.setBase(address);
              reload();
            }}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    );

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.bg },
        headerTintColor: t.cedre,
        headerTitleStyle: { color: t.text, fontWeight: '700' },
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.bg },
        headerBackButtonDisplayMode: 'minimal',
      }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="species/[id]" options={{ title: '' }} />
      <Stack.Screen name="tests" options={{ title: 'Tests enregistrés' }} />
      <Stack.Screen name="settings" options={{ title: 'Réglages' }} />
      <Stack.Screen name="test/[id]" options={{ title: 'Test' }} />
    </Stack>
  );
}

export default function RootLayout() {
  const t = useTheme();
  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: t.bg }}>
        <StatusBar style={t.dark ? 'light' : 'dark'} />
        <CatalogProvider>
          <Gate />
        </CatalogProvider>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  error: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  brand: { fontSize: 44, fontWeight: '800', letterSpacing: -1.5 },
  title: { fontSize: 22, fontWeight: '700' },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16 },
});
