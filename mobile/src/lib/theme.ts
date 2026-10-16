import { useColorScheme } from 'react-native';

// Palette Igdad : Cèdre (principal), Majorelle (mode Audio), Safran (mode Image), Oasis (succès), Terre (erreur)
const light = {
  dark: false,
  bg: '#F7F1E6',
  card: '#FFFFFF',
  line: '#E3DACB',
  text: '#1C2421',
  mute: '#5E6B66',
  cedre: '#1F5E4B',
  majorelle: '#5B4BDB',
  safran: '#F2A93B',
  oasis: '#277A55',
  terre: '#B4432F',
  onCedre: '#FFFFFF',
  onMajorelle: '#FFFFFF',
  onSafran: '#1C2421',
  soft: '#EFE7D8',
  majorelleSoft: '#ECEAFB',
  safranSoft: '#FDF1DC',
};

const dark: typeof light = {
  dark: true,
  bg: '#0F1714',
  card: '#18231F',
  line: '#2A3833',
  text: '#E9EFEC',
  mute: '#9AA8A2',
  cedre: '#4FB394',
  majorelle: '#9A90F5',
  safran: '#F5B955',
  oasis: '#4FB394',
  terre: '#E07A62',
  onCedre: '#0F1714',
  onMajorelle: '#0F1714',
  onSafran: '#0F1714',
  soft: '#1F2C27',
  majorelleSoft: '#25233F',
  safranSoft: '#33291A',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const IUCN_COLORS: Record<string, string> = {
  LC: '#277A55',
  NT: '#8A9A2B',
  VU: '#D08A12',
  EN: '#C8553D',
  CR: '#9B1C1C',
  DD: '#6B7280',
  NE: '#6B7280',
};
