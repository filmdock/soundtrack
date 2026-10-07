// Prove di scripts/sign.sh (bash + openssl, come nel workflow) e di verify.mjs.
// Le chiavi sono generate qui: nessuna chiave vera entra nei test.

import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { publicKeyBase64, verifySignature } from '../lib/signature.mjs';
import { ROOT, childEnv, hasProgram, runProgram, tempDir } from './helpers.mjs';

const SIGN = join(ROOT, 'scripts', 'sign.sh').replaceAll('\\', '/');
const VERIFY = join(ROOT, 'verify.mjs');
const strumenti = hasProgram('bash') && hasProgram('openssl', ['version']);
const MANIFESTO = '{"format":1,"dump":"20261007-002147","built":"2026-10-08T06:31:02Z","file":"soundtrack.sqlite.gz","size":1,"sha256":"' + '0'.repeat(64) + '","albums":1,"titles":1}';

function preparazione(t) {
  const cartella = tempDir(t);
  const tmp = join(cartella, 'tmp');
  mkdirSync(tmp);
  const manifesto = join(cartella, 'soundtrack.json');
  writeFileSync(manifesto, MANIFESTO);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
  const firmare = (chiave) =>
    runProgram('bash', [SIGN, manifesto.replaceAll('\\', '/')], {
      env: childEnv({ SOUNDTRACK_SIGNING_KEY: chiave, TMPDIR: tmp.replaceAll('\\', '/') }),
    });
  return { cartella, tmp, manifesto, firma: `${manifesto}.sig`, publicKey, pem, firmare };
}

test('sign.sh firma con la chiave del segreto, non la stampa, non lascia il file', { skip: !strumenti }, async (t) => {
  const p = preparazione(t);
  const r = await p.firmare(p.pem);
  assert.equal(r.code, 0, r.stderr);
  const firma = readFileSync(p.firma);
  assert.equal(firma.length, 64);
  assert.equal(verifySignature(Buffer.from(MANIFESTO), firma, p.publicKey), true);
  // nessuna riga della chiave nelle uscite, nessun file temporaneo rimasto
  const corpo = p.pem.split('\n').filter((riga) => riga && !riga.startsWith('-----'));
  for (const riga of corpo) {
    assert.equal(r.stdout.includes(riga) || r.stderr.includes(riga), false);
  }
  assert.deepEqual(readdirSync(p.tmp), []);
});

test('sign.sh senza segreto: errore chiaro, nessuna firma (e una vecchia sparisce)', { skip: !strumenti }, async (t) => {
  const p = preparazione(t);
  writeFileSync(p.firma, Buffer.alloc(64));
  const r = await p.firmare('');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /SOUNDTRACK_SIGNING_KEY is missing: nothing was signed or published/);
  assert.equal(existsSync(p.firma), false);
});

test('sign.sh con un segreto che non è una chiave PEM Ed25519: errore, nessuna firma', { skip: !strumenti }, async (t) => {
  const p = preparazione(t);
  const testo = await p.firmare('not a key');
  assert.equal(testo.code, 1);
  assert.match(testo.stderr, /not a PEM private key/);
  assert.equal(existsSync(p.firma), false);

  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  const r = await p.firmare(ec);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nothing was (signed or )?published/);
  assert.equal(existsSync(p.firma), false);
  assert.deepEqual(readdirSync(p.tmp), []);
});

test('verify.mjs: chiave giusta sì, chiave sbagliata no, segnaposto no', { skip: !strumenti }, async (t) => {
  const p = preparazione(t);
  assert.equal((await p.firmare(p.pem)).code, 0);
  const chiave = join(p.cartella, 'public-key.txt');

  writeFileSync(chiave, `${publicKeyBase64(p.publicKey)}\n`);
  const ok = await runProgram(process.execPath, [VERIFY, '--dir', p.cartella, '--key', chiave], { env: childEnv() });
  assert.equal(ok.code, 0, ok.stderr);
  assert.match(ok.stdout, /signature ok: dump 20261007-002147/);

  writeFileSync(chiave, publicKeyBase64(generateKeyPairSync('ed25519').publicKey));
  const altra = await runProgram(process.execPath, [VERIFY, '--dir', p.cartella, '--key', chiave], { env: childEnv() });
  assert.equal(altra.code, 1);
  assert.match(altra.stderr, /not a valid signature/);

  writeFileSync(chiave, 'UNSET\n');
  const vuota = await runProgram(process.execPath, [VERIFY, '--check-key', '--key', chiave], { env: childEnv() });
  assert.equal(vuota.code, 1);
  assert.match(vuota.stderr, /does not hold the Ed25519 public key yet/);
});
