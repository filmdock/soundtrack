// Regole di selezione del pacchetto (logica pura, senza file): quali release group entrano,
// quale uscita si sceglie per le tracce, in che ordine vanno le tracce, quando una traccia
// porta un artista suo.

/** Tipo di relazione MusicBrainz release group → URL «IMDb». */
export const IMDB_LINK_TYPE_GID = '85b0a010-3237-47c7-8476-6fcefd4761af';

/** Artista speciale «Various Artists». */
export const VARIOUS_ARTISTS_MBID = '89ad4ac3-39f7-470e-963a-56509c546377';

/** Tipo primario, tipo secondario e stato richiesti (nomi come nelle tabelle di MusicBrainz). */
export const PRIMARY_TYPE = 'Album';
export const SECONDARY_TYPE = 'Soundtrack';
export const RELEASE_STATUS = 'Official';

const URL_IMDB = /^https?:\/\/(www\.|m\.)?imdb\.com\/title\/tt(\d{7,10})\/?$/;

/**
 * Parte numerica dell'id IMDb di un URL di titolo (`…/title/tt0113277/` → 113277).
 * @param {string} url
 * @returns {number | null}
 */
export function imdbTitleNumber(url) {
  const trovato = URL_IMDB.exec(url);
  return trovato ? Number(trovato[2]) : null;
}

/**
 * @typedef {{ year: number | null, month: number | null, day: number | null }} ReleaseDate
 */

/**
 * Confronta due date d'uscita: anno, poi mese, poi giorno; una parte mancante va dopo
 * qualsiasi valore. Una data assente (nessun evento d'uscita) va dopo tutte.
 * @param {ReleaseDate | null} a
 * @param {ReleaseDate | null} b
 */
export function compareDates(a, b) {
  for (const parte of ['year', 'month', 'day']) {
    const x = a?.[parte] ?? Infinity;
    const y = b?.[parte] ?? Infinity;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * La più vecchia fra due date (per raccogliere gli eventi d'uscita di una release).
 * @param {ReleaseDate | null} a
 * @param {ReleaseDate} b
 */
export function earlierDate(a, b) {
  return a === null || compareDates(b, a) < 0 ? b : a;
}

/**
 * @typedef {{ id: number, gid: string, date: ReleaseDate | null, trackCount: number }} Candidate
 */

/**
 * Sceglie l'uscita ufficiale da cui prendere le tracce: la più vecchia, a pari data quella
 * con l'id più basso, fra quelle che hanno almeno una traccia. L'anno dell'album è quello
 * della prima uscita ufficiale in assoluto, anche se non ha tracce.
 * @param {Candidate[]} ufficiali uscite ufficiali del release group
 * @returns {{ release: Candidate | null, year: number | null }}
 */
export function chooseRelease(ufficiali) {
  const ordinate = [...ufficiali].sort((a, b) => compareDates(a.date, b.date) || a.id - b.id);
  return {
    release: ordinate.find((r) => r.trackCount > 0) ?? null,
    year: ordinate[0]?.date?.year ?? null,
  };
}

/**
 * @typedef {{ id: number, mediumPosition: number, position: number, title: string,
 *   artist: string, lengthMs: number | null, isDataTrack: boolean }} RawTrack
 */

/**
 * Tracce dell'uscita scelta: tutti i supporti, senza le tracce dati, in ordine di supporto e
 * poi di posizione (a pari posizione l'id più basso), numerate da 1. L'artista della traccia
 * resta solo se è diverso da quello dell'album.
 * @param {RawTrack[]} grezze
 * @param {string} artistaAlbum
 * @returns {{ n: number, title: string, artist: string | null, lengthMs: number | null }[]}
 */
export function orderTracks(grezze, artistaAlbum) {
  return grezze
    .filter((t) => !t.isDataTrack)
    .sort((a, b) => a.mediumPosition - b.mediumPosition || a.position - b.position || a.id - b.id)
    .map((t, i) => ({
      n: i + 1,
      title: t.title,
      artist: t.artist === artistaAlbum ? null : t.artist,
      lengthMs: t.lengthMs,
    }));
}
