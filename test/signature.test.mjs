import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { parsePublicKey, publicKeyBase64, verifySignature } from '../lib/signature.mjs';
import { hasProgram, runProgram, tempDir } from './helpers.mjs';

const coppia = () => generateKeyPairSync('ed25519');
const MANIFESTO = Buffer.from('{"format":1,"dump":"20261007-002147"}');

test('chiave pubblica: 44 caratteri base64 andata e ritorno', () => {
  const { publicKey } = coppia();
  const testo = publicKeyBase64(publicKey);
  assert.match(testo, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(publicKeyBase64(parsePublicKey(`${testo}\n`)), testo);
});

test('chiave pubblica: segnaposto e forme sbagliate rifiutate', () => {
  for (const testo of ['UNSET', '', 'abc=', `${'A'.repeat(43)}`, `${'A'.repeat(44)}=`]) {
    assert.throws(() => parsePublicKey(testo), /44 base64 characters/, testo);
  }
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => publicKeyBase64(publicKey), /not an Ed25519 key/);
});

test('firma buona, dati cambiati, chiave sbagliata, lunghezza sbagliata', () => {
  const { publicKey, privateKey } = coppia();
  const firma = sign(null, MANIFESTO, privateKey);
  assert.equal(firma.length, 64);
  assert.equal(verifySignature(MANIFESTO, firma, publicKey), true);
  assert.equal(verifySignature(Buffer.from(`${MANIFESTO} `), firma, publicKey), false);
  assert.equal(verifySignature(MANIFESTO, firma, coppia().publicKey), false);
  assert.equal(verifySignature(MANIFESTO, firma.subarray(0, 63), publicKey), false);
});

test('la firma di openssl pkeyutl -rawin si verifica con node:crypto', { skip: !hasProgram('openssl', ['version']) }, async (t) => {
  const cartella = tempDir(t);
  const { publicKey, privateKey } = coppia();
  const chiave = join(cartella, 'key.pem');
  writeFileSync(chiave, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  const manifesto = join(cartella, 'soundtrack.json');
  writeFileSync(manifesto, MANIFESTO);
  const firma = join(cartella, 'soundtrack.json.sig');
  const r = await runProgram('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', chiave, '-in', manifesto, '-out', firma]);
  assert.equal(r.code, 0, r.stderr);
  const byte = readFileSync(firma);
  assert.equal(byte.length, 64);
  assert.equal(verifySignature(MANIFESTO, byte, publicKey), true);
  // e la riga di 44 caratteri che openssl ricava dalla chiave privata è la stessa
  const der = spawnSync('openssl', ['pkey', '-in', chiave, '-pubout', '-outform', 'DER']).stdout;
  assert.equal(der.subarray(12).toString('base64'), publicKeyBase64(publicKey));
});
