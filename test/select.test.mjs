import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseRelease, compareDates, earlierDate, imdbTitleNumber, orderTracks } from '../lib/select.mjs';

test('imdbTitleNumber: URL di titolo validi', () => {
  assert.equal(imdbTitleNumber('https://www.imdb.com/title/tt0113277/'), 113277);
  assert.equal(imdbTitleNumber('http://imdb.com/title/tt0113277'), 113277);
  assert.equal(imdbTitleNumber('https://m.imdb.com/title/tt12345678/'), 12345678);
  assert.equal(imdbTitleNumber('https://www.imdb.com/title/tt1234567890/'), 1234567890);
});

test('imdbTitleNumber: tutto il resto no', () => {
  for (const url of [
    'https://www.imdb.com/name/nm0000404/',
    'https://www.imdb.com/title/tt0113277/?ref_=x',
    'https://www.imdb.com/title/tt0113277/soundtrack',
    'https://www.imdb.com/title/tt123456/',
    'https://www.imdb.com/title/tt12345678901/',
    'https://imdb.com.example.org/title/tt0113277/',
    'https://www.example.org/title/tt0113277/',
    'ftp://www.imdb.com/title/tt0113277/',
    'https://akas.imdb.com/title/tt0113277/',
  ]) {
    assert.equal(imdbTitleNumber(url), null, url);
  }
});

const d = (year, month = null, day = null) => ({ year, month, day });

test('compareDates: le parti mancanti vanno dopo, la data assente dopo tutte', () => {
  assert.equal(compareDates(d(1995), d(1996, 1, 1)), -1);
  assert.equal(compareDates(d(1996, 3), d(1996, 3, 1)), 1);
  assert.equal(compareDates(d(1996, 3, 1), d(1996, 3, 1)), 0);
  assert.equal(compareDates(d(null, 1, 1), d(2020)), 1);
  assert.equal(compareDates(null, d(null)), 0);
  assert.equal(compareDates(null, d(2099)), 1);
});

test('earlierDate tiene la più vecchia', () => {
  assert.deepEqual(earlierDate(null, d(2000)), d(2000));
  assert.deepEqual(earlierDate(d(2000, 5), d(2000, 4, 30)), d(2000, 4, 30));
  assert.deepEqual(earlierDate(d(2000, 5), d(2000)), d(2000, 5));
});

const uscita = (id, date, trackCount = 1) => ({ id, gid: `r${id}`, date, trackCount });

test('chooseRelease: la più vecchia, a pari data l’id più basso', () => {
  const { release, year } = chooseRelease([uscita(3, d(2001, 5)), uscita(2, d(2001, 5)), uscita(1, null)]);
  assert.equal(release.id, 2);
  assert.equal(year, 2001);
});

test('chooseRelease: salta le uscite senza tracce, ma l’anno è della prima uscita', () => {
  const { release, year } = chooseRelease([uscita(1, d(1996, 3)), uscita(2, d(1995), 0)]);
  assert.equal(release.id, 1);
  assert.equal(year, 1995);
});

test('chooseRelease: nessuna uscita, nessuna con tracce, nessuna data', () => {
  assert.deepEqual(chooseRelease([]), { release: null, year: null });
  assert.deepEqual(chooseRelease([uscita(1, d(2000), 0)]), { release: null, year: 2000 });
  const { release, year } = chooseRelease([uscita(5, null), uscita(4, null)]);
  assert.equal(release.id, 4);
  assert.equal(year, null);
});

test('orderTracks: supporti, posizioni, niente tracce dati, artista solo se diverso', () => {
  const t = (id, mediumPosition, position, artist = 'Composer', isDataTrack = false) => ({
    id,
    mediumPosition,
    position,
    title: `T${id}`,
    artist,
    lengthMs: id * 1000,
    isDataTrack,
  });
  const tracce = orderTracks(
    [t(5, 2, 1), t(3, 1, 2, 'Composer & Singer'), t(1, 1, 1), t(9, 2, 2, 'Composer', true), t(4, 1, 2)],
    'Composer',
  );
  assert.deepEqual(tracce, [
    { n: 1, title: 'T1', artist: null, lengthMs: 1000 },
    { n: 2, title: 'T3', artist: 'Composer & Singer', lengthMs: 3000 },
    { n: 3, title: 'T4', artist: null, lengthMs: 4000 },
    { n: 4, title: 'T5', artist: null, lengthMs: 5000 },
  ]);
  assert.deepEqual(orderTracks([t(1, 1, 1, 'X', true)], 'X'), []);
});
