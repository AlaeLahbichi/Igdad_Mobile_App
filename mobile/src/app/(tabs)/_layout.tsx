import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import { ColorValue } from 'react-native';

import { useTheme } from '../../lib/theme';

type IconName = keyof typeof Ionicons.glyphMap;

export default function TabLayout() {
  const t = useTheme();
  const icon =
    (on: IconName, off: IconName) =>
    ({ color, focused }: { color: ColorValue; focused: boolean }) => <Ionicons name={focused ? on : off} size={24} color={color as string} />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.cedre,
        tabBarInactiveTintColor: t.mute,
        tabBarStyle: { backgroundColor: t.card, borderTopColor: t.line },
        tabBarLabelStyle: { fontSize: 10, fontWeight: '600' },
        sceneStyle: { backgroundColor: t.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: 'Accueil', tabBarIcon: icon('home', 'home-outline') }} />
      <Tabs.Screen
        name="audio"
        options={{ title: 'Chant', tabBarActiveTintColor: t.majorelle, tabBarIcon: icon('mic', 'mic-outline') }}
      />
      <Tabs.Screen
        name="image"
        options={{ title: 'Photo', tabBarActiveTintColor: t.dark ? t.safran : '#C27A0E', tabBarIcon: icon('camera', 'camera-outline') }}
      />
      <Tabs.Screen name="birds" options={{ title: 'Oiseaux', tabBarIcon: icon('book', 'book-outline') }} />
      <Tabs.Screen name="dashboard" options={{ title: 'Dashboard', tabBarIcon: icon('stats-chart', 'stats-chart-outline') }} />
      <Tabs.Screen
        name="about"
        options={{ title: 'À propos', tabBarIcon: icon('information-circle', 'information-circle-outline') }}
      />
    </Tabs>
  );
}
