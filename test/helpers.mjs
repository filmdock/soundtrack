// Aiuti comuni dei test: cartelle temporanee, fixture, programmi esterni.

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURES = join(ROOT, 'test', 'fixtures');
export const FIXTURE_TABLES = join(FIXTURES, 'mbdump');
export const FIXTURE_SCHEMA = join(FIXTURES, 'CreateTables.sql');

/** Cartella temporanea cancellata alla fine del test. */
export function tempDir(t, prefisso = 'soundtrack-test-') {
  const cartella = mkdtempSync(join(tmpdir(), prefisso));
  t.after(() => rmSync(cartella, { recursive: true, force: true }));
  return cartella;
}

/** Vero se il programma esiste (per saltare i test che lo richiedono). */
export function hasProgram(programma, argomenti = ['--version']) {
  const r = spawnSync(programma, argomenti, { stdio: 'ignore' });
  return !r.error;
}

/**
 * Esegue un programma senza bloccare l'event loop (i test servono file via HTTP mentre
 * gira) e ne raccoglie l'uscita.
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function runProgram(programma, argomenti, opzioni = {}) {
  return new Promise((resolve, reject) => {
    const figlio = spawn(programma, argomenti, { ...opzioni, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    figlio.stdout.on('data', (d) => (stdout += d));
    figlio.stderr.on('data', (d) => (stderr += d));
    figlio.on('error', reject);
    figlio.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Ambiente per i processi figli, senza le variabili del workflow vero. */
export function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.GITHUB_ACTIONS;
  if (!('GITHUB_OUTPUT' in extra)) delete env.GITHUB_OUTPUT;
  if (!('SOUNDTRACK_SIGNING_KEY' in extra)) delete env.SOUNDTRACK_SIGNING_KEY;
  return env;
}
