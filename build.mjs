#!/usr/bin/env node
// Costruisce il pacchetto delle colonne sonore dall'ultimo dump completo di MusicBrainz.
//
// Passi: LATEST → (già pubblicato? fine) → CreateTables.sql → mbdump.tar.bz2 + SHA256 →
// estrazione delle sole tabelle usate → selezione a flusso → SQLite → controlli → gzip →
// manifesto. La firma e la release le fa il workflow (la chiave non passa mai da qui).

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DUMP_TABLES, checkSchema, collectSoundtracks } from './lib/collect.mjs';
import {
  DUMP_ARCHIVE,
  DUMP_BASE_URL,
  SCHEMA_URL,
  downloadFile,
  extractArgs,
  fetchText,
  parseLatest,
  parseSha256Sums,
  run,
} from './lib/dump.mjs';
import { releaseState, releaseTag } from './lib/github.mjs';
import {
  MANIFEST_FILE,
  MAX_PACK_BYTES,
  PACK_FILE,
  SIGNATURE_FILE,
  buildTimestamp,
  gunzipFile,
  gzipFile,
  inspectPack,
  manifestJson,
  sha256File,
  writePack,
} from './lib/pack.mjs';
import { parseCreateTables } from './lib/schema.mjs';

const QUI = dirname(fileURLToPath(import.meta.url));
const ULTIMA_COSTRUZIONE = 'last-build.json';

/** Calo massimo di album rispetto alla costruzione precedente prima di fermarsi. */
const CALO_MASSIMO = 0.1;

const AIUTO = `Usage: node build.mjs [options]

  --work <dir>           scratch space for the dump (default: work)
  --out <dir>            where the pack and manifest go (default: out)
  --dump <name>          dump to build (default: the one in LATEST)
  --tables-dir <dir>     use already extracted tables instead of downloading
  --schema-file <file>   use a local CreateTables.sql instead of fetching it
  --base-url <url>       dump folder (default: ${DUMP_BASE_URL})
  --schema-url <url>     CreateTables.sql (default: musicbrainz-server master)
  --decompressor <prog>  program tar uses for bzip2 (default: lbzip2)
  --skip-release-check   build even if pack-<dump> is already released
  --keep-archive         keep mbdump.tar.bz2 after extraction
  --min-albums <n>       refuse a pack with fewer albums (default: 1000)
  --previous <file>      last-build.json of the previous build (default: next to build.mjs)
  --allow-drop           accept more than a 10% drop in albums from the previous build
`;

function opzioni() {
  const { values } = parseArgs({
    options: {
      work: { type: 'string', default: 'work' },
      out: { type: 'string', default: 'out' },
      dump: { type: 'string' },
      'tables-dir': { type: 'string' },
      'schema-file': { type: 'string' },
      'base-url': { type: 'string', default: DUMP_BASE_URL },
      'schema-url': { type: 'string', default: SCHEMA_URL },
      decompressor: { type: 'string', default: 'lbzip2' },
      'skip-release-check': { type: 'boolean', default: false },
      'keep-archive': { type: 'boolean', default: false },
      'min-albums': { type: 'string', default: '1000' },
      previous: { type: 'string', default: join(QUI, ULTIMA_COSTRUZIONE) },
      'allow-drop': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  });
  return values;
}

/** Uscita per i passi dopo nel workflow (`steps.build.outputs.*`). */
function uscita(valori) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  for (const [chiave, valore] of Object.entries(valori)) appendFileSync(file, `${chiave}=${valore}\n`);
}

function dimensioneCartella(cartella) {
  let totale = 0;
  for (const voce of readdirSync(cartella, { withFileTypes: true })) {
    const percorso = join(cartella, voce.name);
    totale += voce.isDirectory() ? dimensioneCartella(percorso) : statSync(percorso).size;
  }
  return totale;
}

const gb = (byte) => `${(byte / 1e9).toFixed(2)} GB`;
const mb = (byte) => `${(byte / 1e6).toFixed(1)} MB`;

async function costruisci(o, log) {
  const work = resolve(o.work);
  const out = resolve(o.out);
  mkdirSync(work, { recursive: true });
  mkdirSync(out, { recursive: true });
  const usciteFile = [PACK_FILE, MANIFEST_FILE, SIGNATURE_FILE, ULTIMA_COSTRUZIONE].map((f) => join(out, f));
  // niente resti di un giro prima (una firma vecchia non deve mai finire accanto a un pacchetto nuovo)
  for (const f of usciteFile) rmSync(f, { force: true });

  const minimo = Number(o['min-albums']);
  if (!Number.isSafeInteger(minimo) || minimo < 1) throw new Error('--min-albums must be a positive integer');
  const base = o['base-url'].replace(/\/+$/, '');

  const dump = parseLatest(o.dump ?? (await fetchText(`${base}/LATEST`)));
  const tag = releaseTag(dump);
  log(`dump ${dump}`);
  if (!o['skip-release-check']) {
    const stato = releaseState(tag);
    if (stato === 'published') {
      log(`${tag} is already published: nothing to do`);
      uscita({ skip: 'true', dump, tag });
      return;
    }
    if (stato === 'draft') log(`${tag} exists as a draft from an earlier run: building again`);
  }

  const schema = parseCreateTables(
    o['schema-file'] ? readFileSync(o['schema-file'], 'utf8') : await fetchText(o['schema-url']),
  );
  checkSchema(schema);
  log(`CreateTables.sql: ${schema.size} tables`);

  try {
    let cartella;
    if (o['tables-dir']) {
      cartella = resolve(o['tables-dir']);
    } else {
      const atteso = parseSha256Sums(await fetchText(`${base}/${dump}/SHA256SUMS`), DUMP_ARCHIVE);
      const archivio = join(work, DUMP_ARCHIVE);
      rmSync(archivio, { force: true });
      log(`downloading ${DUMP_ARCHIVE}`);
      await downloadFile(`${base}/${dump}/${DUMP_ARCHIVE}`, archivio);
      log(`downloaded ${gb(statSync(archivio).size)}`);
      const trovato = await sha256File(archivio);
      if (trovato !== atteso) {
        throw new Error(`${DUMP_ARCHIVE}: SHA256 ${trovato} does not match SHA256SUMS (${atteso})`);
      }
      log('SHA256 matches SHA256SUMS');
      cartella = join(work, 'mbdump');
      rmSync(cartella, { recursive: true, force: true });
      await run('tar', extractArgs(archivio, work, DUMP_TABLES, o.decompressor));
      if (!o['keep-archive']) rmSync(archivio, { force: true });
      log(`extracted ${DUMP_TABLES.length} tables, ${gb(dimensioneCartella(cartella))}`);
    }

    const { albums, stats } = await collectSoundtracks({ dir: cartella, schema, log });
    log(`selection ${JSON.stringify(stats)}`);

    const built = buildTimestamp();
    const sqlite = join(work, 'soundtrack.sqlite');
    writePack(sqlite, { albums, dump, built });
    const pacchetto = inspectPack(sqlite);
    if (pacchetto.dump !== dump || pacchetto.built !== built) throw new Error('pack check failed: meta');
    if (pacchetto.albums < minimo) {
      throw new Error(`only ${pacchetto.albums} albums (minimum ${minimo}): refusing to publish`);
    }
    // un calo forte rispetto alla volta prima è più probabilmente un errore che dati veri
    const prima = existsSync(o.previous) ? JSON.parse(readFileSync(o.previous, 'utf8')) : {};
    if (Number.isSafeInteger(prima.albums) && !o['allow-drop']) {
      const soglia = Math.floor(prima.albums * (1 - CALO_MASSIMO));
      if (pacchetto.albums < soglia) {
        throw new Error(
          `${pacchetto.albums} albums, previous build had ${prima.albums}: more than a 10% drop,` +
            ' refusing to publish (use --allow-drop if expected)',
        );
      }
    }

    const gz = join(out, PACK_FILE);
    await gzipFile(sqlite, gz);
    const size = statSync(gz).size;
    if (size > MAX_PACK_BYTES) throw new Error(`${PACK_FILE} is ${mb(size)}, over the app limit of ${mb(MAX_PACK_BYTES)}`);
    const sha256 = await sha256File(gz);
    // andata e ritorno: il .gz pubblicato deve ridare esattamente il database controllato
    const ritorno = join(work, 'roundtrip.sqlite');
    await gunzipFile(gz, ritorno);
    const uguale = (await sha256File(ritorno)) === (await sha256File(sqlite));
    rmSync(ritorno, { force: true });
    if (!uguale) throw new Error(`${PACK_FILE} does not decompress to the checked database`);

    const { titles, tracks } = pacchetto;
    writeFileSync(
      join(out, MANIFEST_FILE),
      manifestJson({ dump, built, size, sha256, albums: pacchetto.albums, titles }),
    );
    writeFileSync(
      join(out, ULTIMA_COSTRUZIONE),
      `${JSON.stringify({ tag, dump, built, albums: pacchetto.albums, titles, tracks, size, sha256 }, null, 2)}\n`,
    );
    uscita({ skip: 'false', dump, tag });
    log(`pack ready: ${pacchetto.albums} albums, ${titles} IMDb titles, ${tracks} tracks, ${mb(size)}`);
  } catch (errore) {
    for (const f of usciteFile) rmSync(f, { force: true });
    throw errore;
  }
}

async function main() {
  const o = opzioni();
  if (o.help) {
    console.log(AIUTO);
    return;
  }
  const inizio = Date.now();
  const log = (riga) => console.log(`[${((Date.now() - inizio) / 1000).toFixed(0).padStart(5)} s] ${riga}`);
  await costruisci(o, log);
}

main().catch((errore) => {
  const messaggio = errore instanceof Error ? errore.message : String(errore);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${messaggio.replaceAll('\n', ' ')}`);
  console.error(`error: ${messaggio}`);
  process.exitCode = 1;
});
