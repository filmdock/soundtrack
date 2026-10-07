// Il pacchetto (formato 1): SQLite con le quattro tabelle del contratto con l'app, compresso
// gzip, più il manifesto JSON che il robot firma. Lo schema è il contratto: non cambiarlo
// senza alzare `format` (l'app ignora i formati che non conosce).

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip, constants as zlib } from 'node:zlib';

export const PACK_FORMAT = 1;
export const PACK_FILE = 'soundtrack.sqlite.gz';
export const MANIFEST_FILE = 'soundtrack.json';
export const SIGNATURE_FILE = 'soundtrack.json.sig';

/** Limite dell'app per il file scaricato: oltre, il robot non pubblica. */
export const MAX_PACK_BYTES = 100_000_000;

/** Schema SQLite del formato 1, esattamente come lo legge l'app. */
export const SCHEMA_SQL = [
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID',
  `CREATE TABLE album (
  id INTEGER PRIMARY KEY,
  mbid TEXT NOT NULL,
  title TEXT NOT NULL,
  artist TEXT NOT NULL,
  various INTEGER NOT NULL,
  year INTEGER,
  release_mbid TEXT NOT NULL
)`,
  `CREATE TABLE track (
  album INTEGER NOT NULL,
  n INTEGER NOT NULL,
  title TEXT NOT NULL,
  artist TEXT,
  length_ms INTEGER,
  PRIMARY KEY (album, n)
) WITHOUT ROWID`,
  'CREATE TABLE imdb (tt INTEGER NOT NULL, album INTEGER NOT NULL, PRIMARY KEY (tt, album)) WITHOUT ROWID',
];

/**
 * Colonne attese di ogni tabella: [nome, tipo, not null, posizione nella chiave primaria]
 * (nelle tabelle WITHOUT ROWID SQLite segna not null anche la chiave primaria).
 */
const COLONNE_ATTESE = {
  meta: [
    ['key', 'TEXT', 1, 1],
    ['value', 'TEXT', 1, 0],
  ],
  album: [
    ['id', 'INTEGER', 0, 1],
    ['mbid', 'TEXT', 1, 0],
    ['title', 'TEXT', 1, 0],
    ['artist', 'TEXT', 1, 0],
    ['various', 'INTEGER', 1, 0],
    ['year', 'INTEGER', 0, 0],
    ['release_mbid', 'TEXT', 1, 0],
  ],
  track: [
    ['album', 'INTEGER', 1, 1],
    ['n', 'INTEGER', 1, 2],
    ['title', 'TEXT', 1, 0],
    ['artist', 'TEXT', 0, 0],
    ['length_ms', 'INTEGER', 0, 0],
  ],
  imdb: [
    ['tt', 'INTEGER', 1, 1],
    ['album', 'INTEGER', 1, 2],
  ],
};

/**
 * Scrive il pacchetto SQLite (sovrascrive il file se c'è).
 * @param {string} percorso
 * @param {{ albums: import('./collect.mjs').Album[], dump: string, built: string }} dati
 * @returns {{ albums: number, titles: number, tracks: number }}
 */
export function writePack(percorso, { albums, dump, built }) {
  rmSync(percorso, { force: true });
  const db = new DatabaseSync(percorso);
  try {
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec('BEGIN');
    for (const sql of SCHEMA_SQL) db.exec(sql);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('format', String(PACK_FORMAT));
    meta.run('dump', dump);
    meta.run('built', built);
    const album = db.prepare(
      'INSERT INTO album (id, mbid, title, artist, various, year, release_mbid) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const traccia = db.prepare('INSERT INTO track (album, n, title, artist, length_ms) VALUES (?, ?, ?, ?, ?)');
    const imdb = db.prepare('INSERT INTO imdb (tt, album) VALUES (?, ?)');
    const titoli = new Set();
    let tracce = 0;
    albums.forEach((a, i) => {
      const id = i + 1;
      album.run(id, a.mbid, a.title, a.artist, a.various ? 1 : 0, a.year, a.releaseMbid);
      for (const t of a.tracks) traccia.run(id, t.n, t.title, t.artist, t.lengthMs);
      tracce += a.tracks.length;
      for (const tt of a.titles) {
        imdb.run(tt, id);
        titoli.add(tt);
      }
    });
    db.exec('COMMIT');
    db.exec('VACUUM');
    return { albums: albums.length, titles: titoli.size, tracks: tracce };
  } finally {
    db.close();
  }
}

/**
 * Riapre il pacchetto in sola lettura e controlla che rispetti il formato 1: tabelle e
 * colonne esatte, meta, id densi, ogni album con almeno una traccia e un titolo IMDb,
 * tracce numerate da 1 senza buchi, riferimenti validi, integrità SQLite.
 * @param {string} percorso
 * @returns {{ format: number, dump: string, built: string, albums: number, titles: number, tracks: number }}
 */
export function inspectPack(percorso) {
  const db = new DatabaseSync(percorso, { readOnly: true });
  try {
    const uno = (sql) => Object.values(db.prepare(sql).get())[0];
    const problema = (testo) => {
      throw new Error(`pack check failed: ${testo}`);
    };

    const integrita = db.prepare('PRAGMA integrity_check').all();
    if (integrita.length !== 1 || integrita[0].integrity_check !== 'ok') problema('integrity_check');

    const tabelle = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((r) => r.name);
    if (tabelle.join(',') !== 'album,imdb,meta,track') problema(`tables ${tabelle.join(',')}`);
    for (const [tabella, attese] of Object.entries(COLONNE_ATTESE)) {
      const trovate = db
        .prepare(`PRAGMA table_info(${tabella})`)
        .all()
        .map((c) => [c.name, c.type, c.notnull, c.pk]);
      if (JSON.stringify(trovate) !== JSON.stringify(attese)) problema(`columns of ${tabella}`);
    }
    const senzaRowid = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID'")
      .all()
      .map((r) => r.name)
      .sort();
    if (senzaRowid.join(',') !== 'imdb,meta,track') problema('WITHOUT ROWID tables');

    const meta = Object.fromEntries(
      db
        .prepare('SELECT key, value FROM meta')
        .all()
        .map((r) => [r.key, r.value]),
    );
    if (Object.keys(meta).sort().join(',') !== 'built,dump,format') problema('meta keys');
    if (meta.format !== String(PACK_FORMAT)) problema(`meta.format ${meta.format}`);

    const albums = uno('SELECT count(*) FROM album');
    if (albums === 0) problema('no albums');
    if (uno('SELECT min(id) FROM album') !== 1 || uno('SELECT max(id) FROM album') !== albums) {
      problema('album ids are not 1..N');
    }
    if (uno('SELECT count(*) FROM album WHERE various NOT IN (0, 1)') !== 0) problema('album.various');
    if (uno('SELECT count(*) FROM album WHERE id NOT IN (SELECT album FROM track)') !== 0) {
      problema('album without tracks');
    }
    if (uno('SELECT count(*) FROM album WHERE id NOT IN (SELECT album FROM imdb)') !== 0) {
      problema('album without IMDb title');
    }
    if (uno('SELECT count(*) FROM track WHERE album NOT IN (SELECT id FROM album)') !== 0) {
      problema('track of a missing album');
    }
    if (uno('SELECT count(*) FROM imdb WHERE album NOT IN (SELECT id FROM album)') !== 0) {
      problema('imdb row of a missing album');
    }
    const buchi = uno(
      'SELECT count(*) FROM (SELECT album FROM track GROUP BY album HAVING min(n) <> 1 OR max(n) <> count(*))',
    );
    if (buchi !== 0) problema('track numbers are not 1..N');
    const tipi = uno(
      `SELECT count(*) FROM album WHERE typeof(id) <> 'integer' OR typeof(various) <> 'integer'
         OR (year IS NOT NULL AND typeof(year) <> 'integer')`,
    );
    const tipiTracce = uno(
      `SELECT count(*) FROM track WHERE typeof(album) <> 'integer' OR typeof(n) <> 'integer'
         OR (length_ms IS NOT NULL AND typeof(length_ms) <> 'integer')`,
    );
    if (tipi + tipiTracce + uno("SELECT count(*) FROM imdb WHERE typeof(tt) <> 'integer'") !== 0) {
      problema('integer columns hold non-integer values');
    }

    return {
      format: Number(meta.format),
      dump: meta.dump,
      built: meta.built,
      albums,
      titles: uno('SELECT count(DISTINCT tt) FROM imdb'),
      tracks: uno('SELECT count(*) FROM track'),
    };
  } finally {
    db.close();
  }
}

/** Comprime `da` in `a` con gzip (livello massimo). */
export async function gzipFile(da, a) {
  await pipeline(createReadStream(da), createGzip({ level: zlib.Z_BEST_COMPRESSION }), createWriteStream(a));
}

/** Decomprime `da` (gzip) in `a`. */
export async function gunzipFile(da, a) {
  await pipeline(createReadStream(da), createGunzip(), createWriteStream(a));
}

/**
 * SHA-256 di un file, esadecimale minuscolo.
 * @param {string} percorso
 */
export async function sha256File(percorso) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(percorso, { highWaterMark: 1 << 20 }), hash);
  return hash.digest('hex');
}

/**
 * Testo del manifesto: JSON compatto con le chiavi in quest'ordine, senza a capo finale.
 * La firma copre esattamente questi byte.
 * @param {{ dump: string, built: string, size: number, sha256: string, albums: number, titles: number }} m
 */
export function manifestJson({ dump, built, size, sha256, albums, titles }) {
  return JSON.stringify({ format: PACK_FORMAT, dump, built, file: PACK_FILE, size, sha256, albums, titles });
}

/**
 * Legge e controlla un manifesto.
 * @param {string} testo
 */
export function parseManifest(testo) {
  const m = JSON.parse(testo);
  const ok =
    m &&
    m.format === PACK_FORMAT &&
    typeof m.dump === 'string' &&
    /^\d{8}-\d{6}$/.test(m.dump) &&
    typeof m.built === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(m.built) &&
    m.file === PACK_FILE &&
    Number.isSafeInteger(m.size) &&
    m.size > 0 &&
    typeof m.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(m.sha256) &&
    Number.isSafeInteger(m.albums) &&
    Number.isSafeInteger(m.titles);
  if (!ok) throw new Error('manifest: unexpected shape');
  return m;
}

/** Istante di costruzione nel formato del manifesto (`2026-10-08T06:31:02Z`). */
export function buildTimestamp(data = new Date()) {
  return data.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
