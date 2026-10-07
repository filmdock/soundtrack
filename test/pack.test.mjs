import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  SCHEMA_SQL,
  buildTimestamp,
  gunzipFile,
  gzipFile,
  inspectPack,
  manifestJson,
  parseManifest,
  sha256File,
  writePack,
} from '../lib/pack.mjs';
import { tempDir } from './helpers.mjs';

const ALBUMS = [
  {
    mbid: 'a0000000-0000-4000-8000-000000000011',
    title: 'Songs From the Night',
    artist: 'Various Artists',
    various: true,
    year: 2001,
    releaseMbid: 'd0000000-0000-4000-8000-000000001102',
    titles: [101, 202],
    tracks: [
      { n: 1, title: 'Opening', artist: 'Ben Singer', lengthMs: 180000 },
      { n: 2, title: 'Theme', artist: null, lengthMs: null },
    ],
  },
  {
    mbid: 'c0000000-0000-4000-8000-000000000010',
    title: 'Night City',
    artist: 'Ada Composer',
    various: false,
    year: null,
    releaseMbid: 'd0000000-0000-4000-8000-000000001001',
    titles: [101],
    tracks: [{ n: 1, title: 'Main Title', artist: null, lengthMs: 125400 }],
  },
];

function pacchetto(t) {
  const file = join(tempDir(t), 'soundtrack.sqlite');
  const conteggi = writePack(file, { albums: ALBUMS, dump: '20261007-002147', built: '2026-10-08T06:31:02Z' });
  return { file, conteggi };
}

/** Apre il pacchetto in sola lettura e lo chiude prima che la cartella temporanea sparisca. */
function conDb(file, fn) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    fn(db);
  } finally {
    db.close();
  }
}

test('writePack scrive lo schema del formato 1 alla lettera', (t) => {
  const { file, conteggi } = pacchetto(t);
  assert.deepEqual(conteggi, { albums: 2, titles: 2, tracks: 3 });
  conDb(file, (db) => {
  const sql = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' ORDER BY rowid")
    .all()
    .map((r) => r.sql);
  assert.deepEqual(sql, SCHEMA_SQL);
  // nessun indice in più oltre alle chiavi primarie
  const indici = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all();
  assert.deepEqual(indici, []);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  });
});

test('writePack: righe, id densi, tipi interi, NULL dove manca il dato', (t) => {
  const { file } = pacchetto(t);
  conDb(file, (db) => {
  const righe = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
  assert.deepEqual(righe('SELECT key, value FROM meta ORDER BY key'), [
    { key: 'built', value: '2026-10-08T06:31:02Z' },
    { key: 'dump', value: '20261007-002147' },
    { key: 'format', value: '1' },
  ]);
  assert.deepEqual(righe('SELECT id, mbid, artist, various, year, typeof(year) AS ty FROM album ORDER BY id'), [
    { id: 1, mbid: ALBUMS[0].mbid, artist: 'Various Artists', various: 1, year: 2001, ty: 'integer' },
    { id: 2, mbid: ALBUMS[1].mbid, artist: 'Ada Composer', various: 0, year: null, ty: 'null' },
  ]);
  assert.deepEqual(righe('SELECT album, n, title, artist, length_ms, typeof(length_ms) AS ty FROM track'), [
    { album: 1, n: 1, title: 'Opening', artist: 'Ben Singer', length_ms: 180000, ty: 'integer' },
    { album: 1, n: 2, title: 'Theme', artist: null, length_ms: null, ty: 'null' },
    { album: 2, n: 1, title: 'Main Title', artist: null, length_ms: 125400, ty: 'integer' },
  ]);
  assert.deepEqual(righe('SELECT tt, album FROM imdb'), [
    { tt: 101, album: 1 },
    { tt: 101, album: 2 },
    { tt: 202, album: 1 },
  ]);
  });
});

test('inspectPack conta e accetta un pacchetto buono', (t) => {
  const { file } = pacchetto(t);
  assert.deepEqual(inspectPack(file), {
    format: 1,
    dump: '20261007-002147',
    built: '2026-10-08T06:31:02Z',
    albums: 2,
    titles: 2,
    tracks: 3,
  });
});

test('inspectPack rifiuta pacchetti rotti', (t) => {
  const casi = [
    ['DELETE FROM track WHERE album = 2', /album without tracks/],
    ['DELETE FROM imdb WHERE album = 2', /album without IMDb title/],
    ["UPDATE meta SET value = '2' WHERE key = 'format'", /meta.format/],
    ["INSERT INTO meta VALUES ('extra', 'x')", /meta keys/],
    ['CREATE TABLE extra (x)', /tables/],
    ['UPDATE album SET id = 5 WHERE id = 2', /1\.\.N/],
    ['UPDATE track SET n = 3 WHERE album = 1 AND n = 2', /track numbers/],
    ['UPDATE album SET year = 2001.5 WHERE id = 1', /non-integer/],
    ['INSERT INTO imdb VALUES (7, 9)', /missing album/],
    ['DELETE FROM album', /no albums/],
  ];
  for (const [sql, errore] of casi) {
    const { file } = pacchetto(t);
    const db = new DatabaseSync(file);
    db.exec(sql);
    db.close();
    assert.throws(() => inspectPack(file), errore, sql);
  }
});

test('manifesto: chiavi in ordine, compatto, senza a capo; parseManifest lo rilegge', () => {
  const testo = manifestJson({
    dump: '20261007-002147',
    built: '2026-10-08T06:31:02Z',
    size: 12345678,
    sha256: 'ab'.repeat(32),
    albums: 3,
    titles: 4,
  });
  assert.equal(
    testo,
    '{"format":1,"dump":"20261007-002147","built":"2026-10-08T06:31:02Z","file":"soundtrack.sqlite.gz",' +
      `"size":12345678,"sha256":"${'ab'.repeat(32)}","albums":3,"titles":4}`,
  );
  assert.equal(parseManifest(testo).albums, 3);
  for (const rotto of [
    testo.replace('"format":1', '"format":2'),
    testo.replace('"sha256":"ab', '"sha256":"AB'),
    testo.replace('soundtrack.sqlite.gz', 'other.gz'),
    testo.replace('"size":12345678', '"size":-1'),
    '{}',
  ]) {
    assert.throws(() => parseManifest(rotto), /unexpected shape/);
  }
});

test('gzip andata e ritorno, SHA-256 noto, istante di costruzione', async (t) => {
  const cartella = tempDir(t);
  const file = join(cartella, 'a.txt');
  writeFileSync(file, 'abc');
  assert.equal(await sha256File(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  await gzipFile(file, join(cartella, 'a.gz'));
  await gunzipFile(join(cartella, 'a.gz'), join(cartella, 'b.txt'));
  assert.equal(readFileSync(join(cartella, 'b.txt'), 'utf8'), 'abc');
  assert.equal(buildTimestamp(new Date('2026-10-08T06:31:02.789Z')), '2026-10-08T06:31:02Z');
});
