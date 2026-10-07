// Verifica della firma Ed25519 del manifesto con la chiave pubblica del repo.
//
// La chiave pubblica è scritta come base64 dei suoi 32 byte grezzi (44 caratteri), la stessa
// forma che usa l'app. La firma (64 byte grezzi) la fa openssl nel workflow; qui la si
// controlla con node:crypto, un'implementazione diversa, prima di pubblicare.

import { createPublicKey, verify } from 'node:crypto';

/** Prefisso DER (SubjectPublicKeyInfo) di una chiave pubblica Ed25519 da 32 byte. */
const PREFISSO_SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Chiave pubblica Ed25519 dalla sua forma base64 (32 byte grezzi).
 * @param {string} testo contenuto di public-key.txt
 */
export function parsePublicKey(testo) {
  const pulito = testo.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(pulito)) {
    throw new Error('public key: expected 44 base64 characters (the 32 raw bytes of an Ed25519 key)');
  }
  const grezza = Buffer.from(pulito, 'base64');
  if (grezza.length !== 32) throw new Error('public key: expected 32 bytes');
  return createPublicKey({ key: Buffer.concat([PREFISSO_SPKI_ED25519, grezza]), format: 'der', type: 'spki' });
}

/**
 * Forma base64 dei 32 byte grezzi di una chiave pubblica Ed25519.
 * @param {import('node:crypto').KeyObject} chiave
 */
export function publicKeyBase64(chiave) {
  const der = chiave.export({ format: 'der', type: 'spki' });
  if (der.length !== 44 || !der.subarray(0, 12).equals(PREFISSO_SPKI_ED25519)) {
    throw new Error('public key: not an Ed25519 key');
  }
  return der.subarray(12).toString('base64');
}

/**
 * Vero se `firma` (64 byte grezzi) è la firma Ed25519 di `dati` con `chiave`.
 * @param {Buffer} dati
 * @param {Buffer} firma
 * @param {import('node:crypto').KeyObject} chiave
 */
export function verifySignature(dati, firma, chiave) {
  if (firma.length !== 64) return false;
  return verify(null, dati, chiave, firma);
}
