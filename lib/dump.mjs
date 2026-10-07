// Il dump completo di MusicBrainz: quale è l'ultimo, scaricarlo, controllarlo, estrarne solo
// le tabelle che servono. Solo i file pubblici dei dump, mai il servizio web ws/2.

import { spawn } from 'node:child_process';

/** Cartella dei dump completi su data.metabrainz.org. */
export const DUMP_BASE_URL = 'https://data.metabrainz.org/pub/musicbrainz/data/fullexport';

/** Schema delle tabelle (branch master, sola lettura). */
export const SCHEMA_URL =
  'https://raw.githubusercontent.com/metabrainz/musicbrainz-server/master/admin/sql/CreateTables.sql';

/** Archivio con i dati core (CC0). */
export const DUMP_ARCHIVE = 'mbdump.tar.bz2';

/** User-Agent di tutte le richieste del robot. */
export const USER_AGENT = 'filmdock-soundtrack-builder/1 (+https://github.com/filmdock/soundtrack)';

/**
 * Nome del dump dal file LATEST (es. `20261007-002147`).
 * @param {string} testo
 */
export function parseLatest(testo) {
  const nome = testo.trim();
  if (!/^\d{8}-\d{6}$/.test(nome)) throw new Error(`LATEST: unexpected content ${JSON.stringify(nome.slice(0, 40))}`);
  return nome;
}

/**
 * SHA-256 atteso di `file` da un SHA256SUMS (`<hex> *nome` o `<hex>  nome`).
 * @param {string} testo
 * @param {string} file
 */
export function parseSha256Sums(testo, file) {
  for (const riga of testo.split(/\r?\n/)) {
    const trovato = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(riga.trim());
    if (trovato && trovato[2] === file) return trovato[1].toLowerCase();
  }
  throw new Error(`SHA256SUMS: no entry for ${file}`);
}

/**
 * Scarica un testo piccolo (LATEST, SHA256SUMS, CreateTables.sql).
 * @param {string} url
 */
export async function fetchText(url, { timeoutMs = 60_000 } = {}) {
  const risposta = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!risposta.ok) throw new Error(`GET ${url}: HTTP ${risposta.status}`);
  return risposta.text();
}

/** Esegue un programma e aspetta che finisca bene. */
export function run(programma, argomenti, opzioni = {}) {
  return new Promise((resolve, reject) => {
    const figlio = spawn(programma, argomenti, { stdio: 'inherit', ...opzioni });
    figlio.on('error', reject);
    figlio.on('exit', (codice, segnale) => {
      if (codice === 0) resolve();
      else reject(new Error(`${programma} exited with ${segnale ?? codice}`));
    });
  });
}

/**
 * Scarica un file grande con curl: riprova e riprende da dove si era fermato, e interrompe
 * un trasferimento fermo (meno di 100 KB/s per 2 minuti) per riprenderlo.
 * @param {string} url
 * @param {string} destinazione
 */
export function downloadFile(url, destinazione) {
  return run('curl', [
    '--fail',
    '--location',
    '--silent',
    '--show-error',
    '--retry',
    '8',
    '--retry-delay',
    '30',
    '--retry-all-errors',
    '--continue-at',
    '-',
    '--speed-limit',
    '102400',
    '--speed-time',
    '120',
    '--user-agent',
    USER_AGENT,
    '--output',
    destinazione,
    url,
  ]);
}

/**
 * Argomenti di tar per estrarre in un solo passaggio solo `mbdump/<tabella>` delle tabelle
 * date, decomprimendo con `decompressore` (lbzip2 usa tutti i core).
 * @param {string} archivio
 * @param {string} destinazione
 * @param {string[]} tabelle
 * @param {string} decompressore
 */
export function extractArgs(archivio, destinazione, tabelle, decompressore = 'lbzip2') {
  return [
    // su Windows (prove locali) «C:\...» non è un host remoto
    ...(process.platform === 'win32' ? ['--force-local'] : []),
    `--use-compress-program=${decompressore}`,
    '-xf',
    archivio,
    '-C',
    destinazione,
    ...tabelle.map((t) => `mbdump/${t}`),
  ];
}
