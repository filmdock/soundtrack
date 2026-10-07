// Dal dump estratto all'elenco degli album: una passata a flusso per tabella, nell'ordine in
// cui ogni filtro restringe il successivo (IMDb → colonne sonore → album → uscite ufficiali →
// supporti → tracce → artisti). In memoria restano solo le righe che servono.
//
// Si usano solo tabelle dei dati core (CC0): mai tag, generi, voti, annotazioni.

import { join } from 'node:path';
import { bool, int, readTable } from './copytext.mjs';
import { tableColumns } from './schema.mjs';
import {
  IMDB_LINK_TYPE_GID,
  PRIMARY_TYPE,
  RELEASE_STATUS,
  SECONDARY_TYPE,
  VARIOUS_ARTISTS_MBID,
  chooseRelease,
  earlierDate,
  imdbTitleNumber,
  orderTracks,
} from './select.mjs';

/** Colonne usate di ogni tabella del dump: lo schema deve averle tutte. */
const COLONNE_USATE = {
  release_group: ['id', 'gid', 'name', 'artist_credit', 'type'],
  release_group_primary_type: ['id', 'name'],
  release_group_secondary_type: ['id', 'name'],
  release_group_secondary_type_join: ['release_group', 'secondary_type'],
  release: ['id', 'gid', 'release_group', 'status'],
  release_status: ['id', 'name'],
  release_country: ['release', 'date_year', 'date_month', 'date_day'],
  release_unknown_country: ['release', 'date_year', 'date_month', 'date_day'],
  medium: ['id', 'release', 'position', 'track_count'],
  track: ['id', 'medium', 'position', 'name', 'artist_credit', 'length', 'is_data_track'],
  artist_credit: ['id', 'name'],
  artist_credit_name: ['artist_credit', 'artist'],
  artist: ['id', 'gid'],
  l_release_group_url: ['link', 'entity0', 'entity1'],
  url: ['id', 'url'],
  link: ['id', 'link_type'],
  link_type: ['id', 'gid', 'entity_type0', 'entity_type1'],
};

/** Tabelle da estrarre dal dump (`mbdump/<tabella>`). */
export const DUMP_TABLES = Object.keys(COLONNE_USATE);

/**
 * Controlla che CreateTables.sql dichiari tutte le tabelle e le colonne usate.
 * @param {Map<string, string[]>} schema
 */
export function checkSchema(schema) {
  for (const [tabella, colonne] of Object.entries(COLONNE_USATE)) tableColumns(schema, tabella, colonne);
}

/**
 * @typedef {object} Album
 * @property {string} mbid MBID del release group
 * @property {string} title nome del release group
 * @property {string} artist artist credit del release group
 * @property {boolean} various il credito contiene «Various Artists»
 * @property {number | null} year anno della prima uscita ufficiale
 * @property {string} releaseMbid uscita scelta per le tracce
 * @property {number[]} titles parti numeriche degli id IMDb, crescenti
 * @property {{ n: number, title: string, artist: string | null, lengthMs: number | null }[]} tracks
 */

/**
 * Legge le tabelle estratte in `dir` e ritorna gli album del pacchetto, ordinati per MBID.
 * @param {object} o
 * @param {string} o.dir cartella con i file `<tabella>` del dump
 * @param {Map<string, string[]>} o.schema colonne da CreateTables.sql
 * @param {(riga: string) => void} [o.log]
 * @returns {Promise<{ albums: Album[], stats: Record<string, number> }>}
 */
export async function collectSoundtracks({ dir, schema, log = () => {} }) {
  checkSchema(schema);
  const stats = {};

  const leggi = async (tabella, pick, onRow, where) => {
    const inizio = Date.now();
    const { rows, kept } = await readTable({
      file: join(dir, tabella),
      table: tabella,
      columns: schema.get(tabella),
      pick,
      where,
      onRow,
    });
    log(`${tabella}: ${rows} rows read, ${kept} kept (${((Date.now() - inizio) / 1000).toFixed(1)} s)`);
  };

  const idPerNome = async (tabella, nome) => {
    const trovati = [];
    await leggi(tabella, ['id', 'name'], (r) => {
      if (r.name === nome) trovati.push(int(r.id));
    });
    if (trovati.length !== 1) {
      throw new Error(`${tabella}: expected one row named ${nome}, found ${trovati.length}`);
    }
    return trovati[0];
  };

  // 1. Relazione «IMDb» fra release group e URL.
  let tipoImdb = null;
  await leggi('link_type', ['id', 'gid', 'entity_type0', 'entity_type1'], (r) => {
    if (r.gid !== IMDB_LINK_TYPE_GID) return;
    if (r.entity_type0 !== 'release_group' || r.entity_type1 !== 'url') {
      throw new Error(`link_type ${IMDB_LINK_TYPE_GID} is not release_group → url`);
    }
    tipoImdb = int(r.id);
  });
  if (tipoImdb === null) throw new Error(`link_type: IMDb relationship ${IMDB_LINK_TYPE_GID} not found`);

  const legamiImdb = new Set();
  await leggi('link', ['id'], (r) => legamiImdb.add(int(r.id)), {
    column: 'link_type',
    values: new Set([tipoImdb]),
  });

  /** url → release group collegati con la relazione IMDb */
  const gruppiPerUrl = new Map();
  await leggi(
    'l_release_group_url',
    ['entity0', 'entity1'],
    (r) => {
      const url = int(r.entity1);
      const gruppi = gruppiPerUrl.get(url) ?? [];
      gruppi.push(int(r.entity0));
      gruppiPerUrl.set(url, gruppi);
    },
    { column: 'link', values: legamiImdb },
  );
  const conImdb = new Set();
  for (const gruppi of gruppiPerUrl.values()) for (const g of gruppi) conImdb.add(g);
  stats.groupsWithImdbLink = conImdb.size;

  // 2. Tipi: Album (primario), Soundtrack (secondario).
  const tipoAlbum = await idPerNome('release_group_primary_type', PRIMARY_TYPE);
  const tipoColonna = await idPerNome('release_group_secondary_type', SECONDARY_TYPE);

  const colonneSonore = new Set();
  await leggi(
    'release_group_secondary_type_join',
    ['release_group'],
    (r) => {
      const g = int(r.release_group);
      if (conImdb.has(g)) colonneSonore.add(g);
    },
    { column: 'secondary_type', values: new Set([tipoColonna]) },
  );

  // 3. URL IMDb validi (titoli) dei soli release group rimasti.
  const urlUtili = new Set();
  for (const [url, gruppi] of gruppiPerUrl) if (gruppi.some((g) => colonneSonore.has(g))) urlUtili.add(url);
  /** release group → id IMDb numerici */
  const titoliPerGruppo = new Map();
  await leggi(
    'url',
    ['id', 'url'],
    (r) => {
      const tt = imdbTitleNumber(r.url);
      if (tt === null) return;
      for (const g of gruppiPerUrl.get(int(r.id))) {
        if (!colonneSonore.has(g)) continue;
        const titoli = titoliPerGruppo.get(g) ?? new Set();
        titoli.add(tt);
        titoliPerGruppo.set(g, titoli);
      }
    },
    { column: 'id', values: urlUtili },
  );

  // 4. Release group con tipo primario Album.
  const gruppi = new Map();
  await leggi(
    'release_group',
    ['id', 'gid', 'name', 'artist_credit', 'type'],
    (r) => {
      if (int(r.type) !== tipoAlbum) return;
      const id = int(r.id);
      gruppi.set(id, {
        id,
        mbid: r.gid,
        title: r.name,
        credit: int(r.artist_credit),
        titles: [...titoliPerGruppo.get(id)].sort((a, b) => a - b),
      });
    },
    { column: 'id', values: titoliPerGruppo },
  );
  stats.soundtrackAlbumsWithImdb = gruppi.size;

  // 5. Uscite ufficiali e loro data più vecchia (con paese o senza).
  const statoUfficiale = await idPerNome('release_status', RELEASE_STATUS);
  const uscite = new Map();
  await leggi(
    'release',
    ['id', 'gid', 'release_group', 'status'],
    (r) => {
      if (int(r.status) !== statoUfficiale) return;
      const id = int(r.id);
      uscite.set(id, { id, gid: r.gid, group: int(r.release_group), date: null, trackCount: 0 });
    },
    { column: 'release_group', values: gruppi },
  );
  const aggiungiData = (r) => {
    const uscita = uscite.get(int(r.release));
    uscita.date = earlierDate(uscita.date, {
      year: int(r.date_year),
      month: int(r.date_month),
      day: int(r.date_day),
    });
  };
  const pickData = ['release', 'date_year', 'date_month', 'date_day'];
  await leggi('release_country', pickData, aggiungiData, { column: 'release', values: uscite });
  await leggi('release_unknown_country', pickData, aggiungiData, { column: 'release', values: uscite });

  // 6. Supporti: posizione e numero di tracce di ogni uscita.
  const supporti = new Map();
  await leggi(
    'medium',
    ['id', 'release', 'position', 'track_count'],
    (r) => {
      const uscita = uscite.get(int(r.release));
      uscita.trackCount += int(r.track_count);
      supporti.set(int(r.id), { release: uscita.id, position: int(r.position) });
    },
    { column: 'release', values: uscite },
  );

  // 7. Uscita scelta per ogni album.
  const usciteDelGruppo = new Map();
  for (const uscita of uscite.values()) {
    const elenco = usciteDelGruppo.get(uscita.group) ?? [];
    elenco.push(uscita);
    usciteDelGruppo.set(uscita.group, elenco);
  }
  /** id dell'uscita scelta → album in costruzione */
  const scelti = new Map();
  stats.withoutOfficialRelease = 0;
  for (const g of gruppi.values()) {
    const { release, year } = chooseRelease(usciteDelGruppo.get(g.id) ?? []);
    if (!release) {
      stats.withoutOfficialRelease++;
      continue;
    }
    scelti.set(release.id, { ...g, year, releaseMbid: release.gid, grezze: [] });
  }
  const supportiScelti = new Map();
  for (const [id, s] of supporti) if (scelti.has(s.release)) supportiScelti.set(id, s);

  // 8. Tracce dei supporti scelti (la tabella più grande).
  await leggi(
    'track',
    ['id', 'medium', 'position', 'name', 'artist_credit', 'length', 'is_data_track'],
    (r) => {
      const supporto = supportiScelti.get(int(r.medium));
      scelti.get(supporto.release).grezze.push({
        id: int(r.id),
        mediumPosition: supporto.position,
        position: int(r.position),
        title: r.name,
        credit: int(r.artist_credit),
        lengthMs: int(r.length),
        isDataTrack: bool(r.is_data_track),
      });
    },
    { column: 'medium', values: supportiScelti },
  );

  // 9. Artisti: chi è «Various Artists» e i nomi dei crediti.
  let idVari = null;
  await leggi('artist', ['id', 'gid'], (r) => {
    if (r.gid === VARIOUS_ARTISTS_MBID) idVari = int(r.id);
  });
  if (idVari === null) throw new Error(`artist: Various Artists ${VARIOUS_ARTISTS_MBID} not found`);

  const creditiAlbum = new Set();
  const crediti = new Set();
  for (const album of scelti.values()) {
    creditiAlbum.add(album.credit);
    crediti.add(album.credit);
    for (const t of album.grezze) crediti.add(t.credit);
  }
  const creditiVari = new Set();
  await leggi(
    'artist_credit_name',
    ['artist_credit', 'artist'],
    (r) => {
      if (int(r.artist) === idVari) creditiVari.add(int(r.artist_credit));
    },
    { column: 'artist_credit', values: creditiAlbum },
  );
  const nomi = new Map();
  await leggi('artist_credit', ['id', 'name'], (r) => nomi.set(int(r.id), r.name), {
    column: 'id',
    values: crediti,
  });
  const nome = (credito) => {
    const n = nomi.get(credito);
    if (n === undefined) throw new Error(`artist_credit ${credito} not found`);
    return n;
  };

  // 10. Album finiti; senza tracce (solo tracce dati) restano fuori.
  const albums = [];
  stats.withoutTracks = 0;
  for (const a of scelti.values()) {
    const artist = nome(a.credit);
    const tracks = orderTracks(
      a.grezze.map((t) => ({ ...t, artist: nome(t.credit) })),
      artist,
    );
    if (tracks.length === 0) {
      stats.withoutTracks++;
      continue;
    }
    albums.push({
      mbid: a.mbid,
      title: a.title,
      artist,
      various: creditiVari.has(a.credit),
      year: a.year,
      releaseMbid: a.releaseMbid,
      titles: a.titles,
      tracks,
    });
  }
  albums.sort((a, b) => (a.mbid < b.mbid ? -1 : a.mbid > b.mbid ? 1 : 0));
  stats.albums = albums.length;
  return { albums, stats };
}
