import Constants from 'expo-constants';

// Le serveur d'API tourne sur le PC (app/mobile_api.py, port 8000). En développement, Expo connaît
// déjà l'adresse IP du PC (celle du serveur Metro) : on la réutilise.
const API_PORT = 8000;

function guessBase(): string {
  const host = Constants.expoConfig?.hostUri?.split(':')[0];
  return `http://${host || '192.168.1.58'}:${API_PORT}`;
}

let base = guessBase();

export type Species = {
  species: string;
  sci: string;
  fr: string | null;
  en: string | null;
  family: string | null;
  family_fr: string | null;
  order_fr: string | null;
  iucn: string;
  iucn_label: string;
  has_song: boolean;
  n_cells: number;
};

export type Song = {
  kind: 'chant' | 'cri';
  recording_id: number;
  type: string;
  quality: string;
  country: string;
  locality: string;
  date: string | null;
  recordist: string;
  license: string;
  source_url: string;
  duration_s: number;
};

export type SpeciesDetail = Species & {
  inat_id: number;
  note: string | null;
  order: string | null;
  inat_observations: number | null;
  photo_attribution: string | null;
  photo_license: string | null;
  wiki: null | {
    lang: string;
    title: string;
    url: string;
    intro: string;
    [section: string]: string;
  };
  stats: Record<string, number>;
  months_morocco: number[];
  songs: Song[];
  gallery: { bronze_key: string; attribution: string; license: string; place_guess: string; source_url: string }[];
  range: { cell_deg: number; cells: [number, number, number][] };
};

export type Detection = { species: string; conf: number; count: number; segments: [number, number][] };
export type Box = { species: string; conf: number; box: [number, number, number, number] };

export type SavedTest = {
  id: string;
  kind: 'audio' | 'image';
  source: string;
  created: string;
  saved: string;
  name: string | null;
  duration: number | null;
  boxes: Box[] | null;
  detections: Detection[];
};

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base + path, { ...init, signal: ctrl.signal });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `Erreur serveur ${res.status}`);
    return body as T;
  } catch (e: any) {
    if (e?.name === 'AbortError') throw new Error("Le serveur n'a pas répondu à temps.");
    if (e instanceof TypeError) throw new Error(`Serveur injoignable (${base}). Vérifiez que le PC et le téléphone sont sur le même Wi-Fi.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  get base() {
    return base;
  },
  setBase(value: string) {
    base = value.replace(/\/+$/, '');
    if (!/^https?:\/\//.test(base)) base = `http://${base}`;
  },
  photo: (sp: string, w = 400) => `${base}/api/m/photo/${sp}?w=${w}`,
  gallery: (sp: string, i: number, w = 600) => `${base}/api/m/gallery/${sp}/${i}?w=${w}`,
  song: (sp: string, kind: string) => `${base}/api/m/song/${sp}/${kind}`,
  testMedia: (id: string) => `${base}/api/m/tests/${id}/media`,
  get: <T>(path: string, timeoutMs?: number) => request<T>(path, {}, timeoutMs),
  post: <T>(path: string, body: object, timeoutMs?: number) =>
    request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs),
};

export function newSession(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63]);
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + '==');
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out.push(B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + '=');
  }
  return out.join('');
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const pct = (p: number) => `${Math.round(p * 100)} %`;
