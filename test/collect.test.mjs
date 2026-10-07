import assert from 'node:assert/strict';
import { appendFileSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectSoundtracks } from '../lib/collect.mjs';
import { parseCreateTables } from '../lib/schema.mjs';
import { FIXTURE_SCHEMA, FIXTURE_TABLES, tempDir } from './helpers.mjs';

const schema = parseCreateTables(readFileSync(FIXTURE_SCHEMA, 'utf8'));

/** Gli album attesi dalle fixture (vedi i commenti per il perché di ognuno). */
const ATTESI = [
  {
    // Various Artists; due URL IMDb (uno su m.imdb.com, con un altro link della stessa
    // relazione); l'uscita senza data (1101) e quella senza stato (1103) perdono contro 1102
    mbid: 'a0000000-0000-4000-8000-000000000011',
    title: 'Songs From the Night',
    artist: 'Various Artists',
    various: true,
    year: 2001,
    releaseMbid: 'd0000000-0000-4000-8000-000000001102',
    titles: [101, 202],
    tracks: [
      { n: 1, title: 'Opening', artist: 'Ben Singer', lengthMs: 180000 },
      { n: 2, title: 'Theme', artist: null, lengthMs: 200000 },
      { n: 3, title: 'Theme (Reprise)', artist: 'Ada Composer & Ben Singer', lengthMs: 60000 },
    ],
  },
  {
    // due uscite ufficiali con la stessa data: vince l'id più basso (1701)
    mbid: 'b0000000-0000-4000-8000-000000000017',
    title: 'Harbor Lights: Music From the Series',
    artist: 'Cleo Harbor',
    various: false,
    year: 2010,
    releaseMbid: 'd0000000-0000-4000-8000-000000001701',
    titles: [12345678],
    tracks: [
      { n: 1, title: 'Harbor Lights', artist: null, lengthMs: 210000 },
      { n: 2, title: 'Low Tide', artist: null, lengthMs: 190500 },
    ],
  },
  {
    // anno 1995 dall'uscita senza tracce, tracce da 1001 (due supporti in ordine inverso,
    // una traccia dati esclusa, una durata ignota, un titolo con tab e barra rovesciata);
    // l'URL con ?ref_ non vale, il bootleg del 1990 non conta
    mbid: 'c0000000-0000-4000-8000-000000000010',
    title: 'Night City (Original Motion Picture Soundtrack)',
    artist: 'Ada Composer',
    various: false,
    year: 1995,
    releaseMbid: 'd0000000-0000-4000-8000-000000001001',
    titles: [101],
    tracks: [
      { n: 1, title: 'Main Title', artist: null, lengthMs: 125400 },
      { n: 2, title: 'Rain\tand\\Neon', artist: 'Ada Composer & Ben Singer', lengthMs: null },
      { n: 3, title: 'End Titles', artist: null, lengthMs: 245000 },
      { n: 4, title: 'Bonus Suite', artist: null, lengthMs: 600000 },
    ],
  },
];

test('dalle fixture escono esattamente gli album attesi', async () => {
  const righe = [];
  const { albums, stats } = await collectSoundtracks({ dir: FIXTURE_TABLES, schema, log: (r) => righe.push(r) });
  assert.deepEqual(albums, ATTESI);
  // EP, URL non di titolo, non colonna sonora, solo Discogs restano fuori prima;
  // solo bootleg/promo e solo tracce dati restano fuori dopo
  assert.deepEqual(stats, {
    groupsWithImdbLink: 8,
    soundtrackAlbumsWithImdb: 5,
    withoutOfficialRelease: 1,
    withoutTracks: 1,
    albums: 3,
  });
  assert.equal(righe.filter((r) => /rows read/.test(r)).length, 17);
});

function copiaFixture(t) {
  const cartella = join(tempDir(t), 'mbdump');
  cpSync(FIXTURE_TABLES, cartella, { recursive: true });
  return cartella;
}

test('una riga di track con un campo in più ferma tutto', async (t) => {
  const cartella = copiaFixture(t);
  appendFileSync(join(cartella, 'track'), '39999\tx\t1\t2002\t9\t9\tExtra\t100\t1\t0\tts\tf\tsurplus\n');
  await assert.rejects(collectSoundtracks({ dir: cartella, schema }), /track: line 16 has 13 fields/);
});

test('senza la relazione IMDb o senza Various Artists si ferma', async (t) => {
  const senzaImdb = copiaFixture(t);
  const linkType = join(senzaImdb, 'link_type');
  writeFileSync(linkType, readFileSync(linkType, 'utf8').replace('85b0a010', '00000000'));
  await assert.rejects(collectSoundtracks({ dir: senzaImdb, schema }), /IMDb relationship .* not found/);

  const senzaVari = copiaFixture(t);
  const artist = join(senzaVari, 'artist');
  writeFileSync(artist, readFileSync(artist, 'utf8').replace('89ad4ac3', '00000000'));
  await assert.rejects(collectSoundtracks({ dir: senzaVari, schema }), /Various Artists .* not found/);
});

test('un tipo con il nome ripetuto è un errore, non una scelta a caso', async (t) => {
  const cartella = copiaFixture(t);
  appendFileSync(join(cartella, 'release_status'), '9\tOfficial\t\\N\t9\t\t90000000-0000-4000-8000-000000000099\n');
  await assert.rejects(collectSoundtracks({ dir: cartella, schema }), /release_status: expected one row named Official, found 2/);
});

test('un credito mancante è un errore', async (t) => {
  const cartella = copiaFixture(t);
  const crediti = join(cartella, 'artist_credit');
  writeFileSync(
    crediti,
    readFileSync(crediti, 'utf8')
      .split('\n')
      .filter((r) => !r.startsWith('104\t'))
      .join('\n'),
  );
  await assert.rejects(collectSoundtracks({ dir: cartella, schema }), /artist_credit 104 not found/);
});
