#!/usr/bin/env node
// Verifica un pacchetto: firma Ed25519 del manifesto con public-key.txt, poi dimensione e
// SHA-256 del .gz; con --deep anche il contenuto SQLite. Il workflow lo usa prima di
// pubblicare; chiunque può usarlo sui file scaricati da una release.
//
//   node verify.mjs [--dir <cartella>] [--key public-key.txt] [--deep]
//   node verify.mjs --check-key        solo: public-key.txt contiene una chiave valida?

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  MANIFEST_FILE,
  PACK_FILE,
  SIGNATURE_FILE,
  gunzipFile,
  inspectPack,
  parseManifest,
  sha256File,
} from './lib/pack.mjs';
import { parsePublicKey, verifySignature } from './lib/signature.mjs';

const QUI = dirname(fileURLToPath(import.meta.url));

async function main() {
  const { values: o } = parseArgs({
    options: {
      dir: { type: 'string', default: '.' },
      key: { type: 'string', default: join(QUI, 'public-key.txt') },
      deep: { type: 'boolean', default: false },
      'check-key': { type: 'boolean', default: false },
    },
    strict: true,
  });

  let chiave;
  try {
    chiave = parsePublicKey(readFileSync(o.key, 'utf8'));
  } catch (errore) {
    throw new Error(
      `${o.key} does not hold the Ed25519 public key yet (${errore.message}): nothing can be signed or verified`,
    );
  }
  if (o['check-key']) {
    console.log(`public key ok (${o.key})`);
    return;
  }

  const cartella = resolve(o.dir);
  const testo = readFileSync(join(cartella, MANIFEST_FILE));
  const firma = readFileSync(join(cartella, SIGNATURE_FILE));
  if (!verifySignature(testo, firma, chiave)) {
    throw new Error(`${SIGNATURE_FILE} is not a valid signature of ${MANIFEST_FILE} for this public key`);
  }
  const manifesto = parseManifest(testo.toString('utf8'));
  console.log(`signature ok: dump ${manifesto.dump}, ${manifesto.albums} albums, ${manifesto.titles} titles`);

  const gz = join(cartella, PACK_FILE);
  if (!existsSync(gz)) {
    if (o.deep) throw new Error(`${PACK_FILE} not found`);
    return;
  }
  if (statSync(gz).size !== manifesto.size) throw new Error(`${PACK_FILE}: size differs from the manifest`);
  if ((await sha256File(gz)) !== manifesto.sha256) throw new Error(`${PACK_FILE}: SHA-256 differs from the manifest`);
  console.log(`${PACK_FILE}: size and SHA-256 match`);

  if (!o.deep) return;
  const temporanea = mkdtempSync(join(tmpdir(), 'soundtrack-verify-'));
  try {
    const sqlite = join(temporanea, 'soundtrack.sqlite');
    await gunzipFile(gz, sqlite);
    const p = inspectPack(sqlite);
    if (p.dump !== manifesto.dump || p.built !== manifesto.built) throw new Error('pack meta differs from the manifest');
    if (p.albums !== manifesto.albums || p.titles !== manifesto.titles) {
      throw new Error('pack counts differ from the manifest');
    }
    console.log(`pack ok: format ${p.format}, ${p.albums} albums, ${p.titles} titles, ${p.tracks} tracks`);
  } finally {
    rmSync(temporanea, { recursive: true, force: true });
  }
}

main().catch((errore) => {
  const messaggio = errore instanceof Error ? errore.message : String(errore);
  if (process.env.GITHUB_ACTIONS === 'true') console.log(`::error::${messaggio.replaceAll('\n', ' ')}`);
  console.error(`error: ${messaggio}`);
  process.exitCode = 1;
});
