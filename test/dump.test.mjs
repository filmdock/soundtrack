import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DUMP_TABLES } from '../lib/collect.mjs';
import { extractArgs, parseLatest, parseSha256Sums } from '../lib/dump.mjs';
import { releaseState, releaseTag } from '../lib/github.mjs';

test('parseLatest: il nome del dump, con o senza a capo', () => {
  assert.equal(parseLatest('20261007-002147\n'), '20261007-002147');
  for (const testo of ['', 'latest-is-20261007-002147', '20261007', '<html>']) {
    assert.throws(() => parseLatest(testo), /LATEST: unexpected content/);
  }
});

test('parseSha256Sums: righe con asterisco o con due spazi', () => {
  const somme = [
    'd010292410e86207bee6c93ea0f34ed6afe62cd49a9a4e6a4b03eb32a1a44efd *mbdump-cdstubs.tar.bz2',
    '06C99BF3DF27570C9DE0E4130469D0452C6C49E74C799F9F817E2112D79763DA *mbdump.tar.bz2',
    '881b03a8d9bff5fc094495427ebc0e678d2dc43456bc5594ee90c22a05872906  mbdump-stats.tar.bz2',
    '',
  ].join('\n');
  assert.equal(
    parseSha256Sums(somme, 'mbdump.tar.bz2'),
    '06c99bf3df27570c9de0e4130469d0452c6c49e74c799f9f817e2112d79763da',
  );
  assert.equal(parseSha256Sums(somme, 'mbdump-stats.tar.bz2').slice(0, 6), '881b03');
  assert.throws(() => parseSha256Sums(somme, 'mbdump-derived.tar.bz2'), /no entry for mbdump-derived/);
});

test('extractArgs: un solo passaggio, solo mbdump/<tabella>, decompressore scelto', () => {
  const argomenti = extractArgs('/w/mbdump.tar.bz2', '/w', DUMP_TABLES);
  assert.ok(argomenti.includes('--use-compress-program=lbzip2'));
  const membri = argomenti.filter((a) => a.startsWith('mbdump/'));
  assert.deepEqual(membri, DUMP_TABLES.map((t) => `mbdump/${t}`));
  assert.equal(membri.length, 17);
  assert.ok(extractArgs('a', 'b', ['track'], 'bzip2').includes('--use-compress-program=bzip2'));
});

test('releaseState: pubblicata, bozza, assente, errore', () => {
  const finto = (status, stdout = '', stderr = '') => () => ({ status, stdout, stderr });
  assert.equal(releaseTag('20261007-002147'), 'pack-20261007-002147');
  assert.equal(releaseState('pack-x', { run: finto(0, 'false\n') }), 'published');
  assert.equal(releaseState('pack-x', { run: finto(0, 'true\n') }), 'draft');
  assert.equal(releaseState('pack-x', { run: finto(1, '', 'release not found\n') }), 'absent');
  assert.throws(() => releaseState('pack-x', { run: finto(1, '', 'HTTP 401: Bad credentials') }), /401/);
  assert.throws(() => releaseState('pack-x', { run: () => ({ error: new Error('spawn gh ENOENT') }) }), /ENOENT/);
});
