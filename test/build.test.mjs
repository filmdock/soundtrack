// Prove di build.mjs da capo a fondo: un dump finto (le fixture in un tar.bz2 vero) servito
// da un server HTTP locale, scaricato con curl, controllato, estratto con tar, costruito.

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { DUMP_TABLES } from '../lib/collect.mjs';
import { USER_AGENT } from '../lib/dump.mjs';
import { gunzipFile, inspectPack, parseManifest, sha256File } from '../lib/pack.mjs';
import { publicKeyBase64 } from '../lib/signature.mjs';
import { FIXTURE_SCHEMA, FIXTURE_TABLES, ROOT, childEnv, hasProgram, runProgram, tempDir } from './helpers.mjs';

const DUMP = '20261007-002147';
const BUILD = join(ROOT, 'build.mjs');
const VERIFY = join(ROOT, 'verify.mjs');
const USCITE = ['soundtrack.sqlite.gz', 'soundtrack.json', 'soundtrack.json.sig', 'last-build.json'];
const strumenti = hasProgram('tar') && hasProgram('bzip2', ['--help']) && hasProgram('curl');

/** Le fixture impacchettate come il dump vero (`mbdump/<tabella>` più i file in radice). */
async function preparaDump(t, { sommaSbagliata = false } = {}) {
  const radice = tempDir(t);
  const stage = join(radice, 'stage');
  mkdirSync(join(stage, 'mbdump'), { recursive: true });
  cpSync(FIXTURE_TABLES, join(stage, 'mbdump'), { recursive: true });
  // una tabella che non serve: non deve essere estratta
  writeFileSync(join(stage, 'mbdump', 'recording'), '1\tunused\n');
  writeFileSync(join(stage, 'TIMESTAMP'), '2026-10-07 00:21:48.263241+00\n');
  writeFileSync(join(stage, 'SCHEMA_SEQUENCE'), '31\n');

  const sito = join(radice, 'site');
  const cartellaDump = join(sito, 'fullexport', DUMP);
  mkdirSync(cartellaDump, { recursive: true });
  const archivio = join(cartellaDump, 'mbdump.tar.bz2');
  const r = await runProgram('tar', [
    ...(process.platform === 'win32' ? ['--force-local'] : []),
    '--use-compress-program=bzip2',
    '-cf',
    archivio,
    '-C',
    stage,
    'TIMESTAMP',
    'SCHEMA_SEQUENCE',
    'mbdump',
  ]);
  assert.equal(r.code, 0, r.stderr);
  const somma = sommaSbagliata ? '0'.repeat(64) : await sha256File(archivio);
  writeFileSync(
    join(cartellaDump, 'SHA256SUMS'),
    `${'1'.repeat(64)} *mbdump-derived.tar.bz2\n${somma} *mbdump.tar.bz2\n`,
  );
  writeFileSync(join(sito, 'fullexport', 'LATEST'), `${DUMP}\n`);
  copyFileSync(FIXTURE_SCHEMA, join(sito, 'CreateTables.sql'));
  return { radice, sito };
}

/** Server statico locale; registra percorso e User-Agent di ogni richiesta. */
async function servi(t, sito) {
  const richieste = [];
  const server = createServer((req, res) => {
    richieste.push({ path: req.url, ua: req.headers['user-agent'] });
    const percorso = resolve(join(sito, decodeURIComponent(new URL(req.url, 'http://local').pathname)));
    if (!percorso.startsWith(sito + sep) || !existsSync(percorso) || statSync(percorso).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-length': statSync(percorso).size });
    createReadStream(percorso).pipe(res);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  t.after(() => new Promise((ok) => server.close(ok)));
  return { base: `http://127.0.0.1:${server.address().port}`, richieste };
}

function argomentiRete(base, radice, extra = []) {
  return [
    BUILD,
    '--work',
    join(radice, 'work'),
    '--out',
    join(radice, 'out'),
    '--base-url',
    `${base}/fullexport`,
    '--schema-url',
    `${base}/CreateTables.sql`,
    '--decompressor',
    'bzip2',
    '--skip-release-check',
    '--min-albums',
    '1',
    '--previous',
    join(radice, 'last-build.json'),
    ...extra,
  ];
}

/** Costruzione senza rete: tabelle e schema dalle fixture. */
function argomentiLocali(radice, extra = []) {
  return [
    BUILD,
    '--work',
    join(radice, 'work'),
    '--out',
    join(radice, 'out'),
    '--dump',
    DUMP,
    '--tables-dir',
    FIXTURE_TABLES,
    '--schema-file',
    FIXTURE_SCHEMA,
    '--skip-release-check',
    '--min-albums',
    '1',
    '--previous',
    join(radice, 'last-build.json'),
    ...extra,
  ];
}

const uscitePresenti = (radice) => USCITE.filter((f) => existsSync(join(radice, 'out', f)));

test('dump finto: scarica, controlla, estrae solo le tabelle usate, costruisce', { skip: !strumenti }, async (t) => {
  const { radice, sito } = await preparaDump(t);
  const { base, richieste } = await servi(t, sito);
  const ghOutput = join(radice, 'github-output');
  const r = await runProgram(process.execPath, argomentiRete(base, radice), {
    env: childEnv({ GITHUB_OUTPUT: ghOutput }),
  });
  assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);

  // richieste: LATEST, schema, SHA256SUMS, archivio; tutte con lo User-Agent del robot
  assert.deepEqual(
    richieste.map((q) => q.path),
    ['/fullexport/LATEST', '/CreateTables.sql', `/fullexport/${DUMP}/SHA256SUMS`, `/fullexport/${DUMP}/mbdump.tar.bz2`],
  );
  for (const q of richieste) assert.equal(q.ua, USER_AGENT);

  // solo le 17 tabelle, e l'archivio cancellato dopo l'estrazione
  assert.deepEqual(readdirSync(join(radice, 'work', 'mbdump')).sort(), [...DUMP_TABLES].sort());
  assert.equal(existsSync(join(radice, 'work', 'mbdump.tar.bz2')), false);

  const out = join(radice, 'out');
  const testo = readFileSync(join(out, 'soundtrack.json'), 'utf8');
  const manifesto = parseManifest(testo);
  assert.equal(testo.endsWith('}'), true);
  assert.equal(manifesto.dump, DUMP);
  assert.equal(manifesto.albums, 3);
  assert.equal(manifesto.titles, 3);
  const gz = join(out, 'soundtrack.sqlite.gz');
  assert.equal(statSync(gz).size, manifesto.size);
  assert.equal(await sha256File(gz), manifesto.sha256);
  assert.equal(existsSync(join(out, 'soundtrack.json.sig')), false);

  const sqlite = join(radice, 'back.sqlite');
  await gunzipFile(gz, sqlite);
  const p = inspectPack(sqlite);
  assert.deepEqual(
    { dump: p.dump, built: p.built, albums: p.albums, titles: p.titles, tracks: p.tracks },
    { dump: DUMP, built: manifesto.built, albums: 3, titles: 3, tracks: 9 },
  );

  assert.equal(readFileSync(ghOutput, 'utf8'), `skip=false\ndump=${DUMP}\ntag=pack-${DUMP}\n`);
  const ultima = JSON.parse(readFileSync(join(out, 'last-build.json'), 'utf8'));
  assert.deepEqual(ultima, {
    tag: `pack-${DUMP}`,
    dump: DUMP,
    built: manifesto.built,
    albums: 3,
    titles: 3,
    tracks: 9,
    size: manifesto.size,
    sha256: manifesto.sha256,
  });

  // firmato (qui con node:crypto) passa la verifica completa di verify.mjs
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(join(out, 'soundtrack.json.sig'), sign(null, Buffer.from(testo), privateKey));
  const chiave = join(radice, 'public-key.txt');
  writeFileSync(chiave, `${publicKeyBase64(publicKey)}\n`);
  const v = await runProgram(process.execPath, [VERIFY, '--dir', out, '--key', chiave, '--deep'], { env: childEnv() });
  assert.equal(v.code, 0, v.stderr);
  assert.match(v.stdout, /pack ok: format 1, 3 albums, 3 titles, 9 tracks/);
});

test('SHA256 diverso da SHA256SUMS: si ferma e non lascia niente da pubblicare', { skip: !strumenti }, async (t) => {
  const { radice, sito } = await preparaDump(t, { sommaSbagliata: true });
  const { base } = await servi(t, sito);
  const r = await runProgram(process.execPath, argomentiRete(base, radice), { env: childEnv() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /mbdump\.tar\.bz2: SHA256 [0-9a-f]{64} does not match SHA256SUMS/);
  assert.deepEqual(uscitePresenti(radice), []);
  assert.equal(existsSync(join(radice, 'work', 'mbdump')), false);
});

test('pochi album: si rifiuta di pubblicare', async (t) => {
  const radice = tempDir(t);
  const r = await runProgram(process.execPath, argomentiLocali(radice, ['--min-albums', '4']), { env: childEnv() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /only 3 albums \(minimum 4\): refusing to publish/);
  assert.deepEqual(uscitePresenti(radice), []);
});

test('calo forte rispetto alla costruzione prima: fermo, salvo --allow-drop', async (t) => {
  const radice = tempDir(t);
  writeFileSync(join(radice, 'last-build.json'), JSON.stringify({ albums: 10 }));
  const r = await runProgram(process.execPath, argomentiLocali(radice), { env: childEnv() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /3 albums, previous build had 10: more than a 10% drop/);
  assert.deepEqual(uscitePresenti(radice), []);

  const ok = await runProgram(process.execPath, argomentiLocali(radice, ['--allow-drop']), { env: childEnv() });
  assert.equal(ok.code, 0, ok.stderr);
  // il segnaposto (albums null) non ferma niente
  writeFileSync(join(radice, 'last-build.json'), JSON.stringify({ albums: null }));
  const segnaposto = await runProgram(process.execPath, argomentiLocali(radice), { env: childEnv() });
  assert.equal(segnaposto.code, 0, segnaposto.stderr);
});

test('una firma vecchia nella cartella di uscita sparisce all’avvio', async (t) => {
  const radice = tempDir(t);
  mkdirSync(join(radice, 'out'));
  writeFileSync(join(radice, 'out', 'soundtrack.json.sig'), Buffer.alloc(64));
  const r = await runProgram(process.execPath, argomentiLocali(radice), { env: childEnv() });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(uscitePresenti(radice), ['soundtrack.sqlite.gz', 'soundtrack.json', 'last-build.json']);
});

test('schema cambiato (una colonna in meno in track): si ferma con il numero di campi', async (t) => {
  const radice = tempDir(t);
  const schema = join(radice, 'CreateTables.sql');
  writeFileSync(schema, readFileSync(FIXTURE_SCHEMA, 'utf8').replace(/^\s+recording\s+INTEGER\b.*\n/m, ''));
  const argomenti = argomentiLocali(radice);
  argomenti[argomenti.indexOf('--schema-file') + 1] = schema;
  const r = await runProgram(process.execPath, argomenti, { env: childEnv() });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /track: line 1 has 12 fields, CreateTables.sql declares 11/);
  assert.deepEqual(uscitePresenti(radice), []);
});
