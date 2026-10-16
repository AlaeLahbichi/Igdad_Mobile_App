import * as Location from 'expo-location';

// Position du téléphone jointe à chaque analyse (carte du Dashboard). Facultative : si l'utilisateur refuse,
// les détections sont enregistrées sans coordonnées.
let cache: { lat: number; lon: number; at: number } | null = null;
let asked: Promise<boolean> | null = null;

async function allowed(): Promise<boolean> {
  if (!asked) {
    asked = Location.requestForegroundPermissionsAsync()
      .then((p) => p.granted)
      .catch(() => false);
  }
  return asked;
}

/** Dernière position connue (moins de 2 min), sinon une mesure rapide ; null si refusée ou indisponible. */
export async function getPosition(): Promise<{ lat: number; lon: number } | null> {
  if (cache && Date.now() - cache.at < 120000) return { lat: cache.lat, lon: cache.lon };
  if (!(await allowed())) return null;
  try {
    const last = await Location.getLastKnownPositionAsync({ maxAge: 120000 });
    const pos =
      last ??
      (await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((ok) => setTimeout(() => ok(null), 4000)),
      ]));
    if (!pos) return null;
    cache = { lat: pos.coords.latitude, lon: pos.coords.longitude, at: Date.now() };
    return { lat: cache.lat, lon: cache.lon };
  } catch {
    return null;
  }
}

/** Version synchrone pour les envois fréquents (temps réel) : position en cache ou rien. */
export function cachedPosition(): { lat?: number; lon?: number } {
  return cache ? { lat: cache.lat, lon: cache.lon } : {};
}
