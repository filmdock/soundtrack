import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FieldCountError, bool, decodeField, int, readTable } from '../lib/copytext.mjs';
import { tempDir } from './helpers.mjs';

test('decodeField: NULL, escape e testo semplice', () => {
  assert.equal(decodeField('\\N'), null);
  assert.equal(decodeField('plain'), 'plain');
  assert.equal(decodeField(''), '');
  assert.equal(decodeField('a\\tb'), 'a\tb');
  assert.equal(decodeField('line\\nnext\\r'), 'line\nnext\r');
  assert.equal(decodeField('back\\\\slash'), 'back\\slash');
  assert.equal(decodeField('\\\\N'), '\\N');
  assert.equal(decodeField('\\b\\f\\v'), '\b\f\v');
  assert.equal(decodeField('café \\\\ 音'), 'café \\ 音');
  // COPY non protegge U+2028 e U+2029: restano come sono
  assert.equal(decodeField('a b c'), 'a b c');
  assert.equal(decodeField('a\\t '), 'a\t ');
});

test('decodeField: sequenze che COPY TO non produce fermano tutto', () => {
  assert.throws(() => decodeField('end\\'), /end of a field/);
  assert.throws(() => decodeField('\\101'), /unexpected escape/);
  assert.throws(() => decodeField('\\x41'), /unexpected escape/);
});

test('int e bool', () => {
  assert.equal(int(null), null);
  assert.equal(int('42'), 42);
  assert.equal(int('-1'), -1);
  assert.throws(() => int('4.2'), /integer/);
  assert.throws(() => int(''), /integer/);
  assert.equal(bool('t'), true);
  assert.equal(bool('f'), false);
  assert.throws(() => bool(null), /t or f/);
});

const colonne = ['id', 'name', 'group', 'note'];

function scrivi(t, testo) {
  const file = join(tempDir(t), 'table');
  writeFileSync(file, testo);
  return file;
}

test('readTable: colonne scelte, filtro su intero, NULL escluso dal filtro', async (t) => {
  const file = scrivi(t, '1\tone\t10\t\\N\n2\ttwo\\tbis\t20\tx\n3\tthree\t\\N\ty\n4\tfour\t10\t\n');
  const righe = [];
  const r = await readTable({
    file,
    table: 'demo',
    columns: colonne,
    pick: ['id', 'name', 'note'],
    where: { column: 'group', values: new Set([10, 20]) },
    onRow: (riga) => righe.push(riga),
  });
  assert.deepEqual(r, { rows: 4, kept: 3 });
  assert.deepEqual(righe, [
    { id: '1', name: 'one', note: null },
    { id: '2', name: 'two\tbis', note: 'x' },
    { id: '4', name: 'four', note: '' },
  ]);
});

test('readTable: un campo in più o in meno ferma la lettura con il numero di riga', async (t) => {
  const file = scrivi(t, '1\ta\t1\tn\n2\tb\t1\n3\tc\t1\tn\n');
  await assert.rejects(
    readTable({ file, table: 'demo', columns: colonne, pick: ['id'], onRow: () => {} }),
    (e) => e instanceof FieldCountError && /demo: line 2 has 3 fields, CreateTables.sql declares 4/.test(e.message),
  );
  const troppi = scrivi(t, '1\ta\t1\tn\textra\n');
  await assert.rejects(
    readTable({ file: troppi, table: 'demo', columns: colonne, pick: ['id'], onRow: () => {} }),
    /line 1 has 5 fields/,
  );
});

test('readTable: anche le righe scartate dal filtro devono avere i campi giusti', async (t) => {
  const file = scrivi(t, '1\ta\t99\n');
  await assert.rejects(
    readTable({
      file,
      table: 'demo',
      columns: colonne,
      pick: ['id'],
      where: { column: 'group', values: new Set([1]) },
      onRow: () => {},
    }),
    FieldCountError,
  );
});

test('readTable: un errore in onRow ferma la lettura', async (t) => {
  const file = scrivi(t, '1\ta\t1\tn\n2\tb\t1\tn\n');
  let viste = 0;
  await assert.rejects(
    readTable({
      file,
      table: 'demo',
      columns: colonne,
      pick: ['id'],
      onRow: () => {
        viste++;
        throw new Error('boom');
      },
    }),
    /boom/,
  );
  assert.equal(viste, 1);
});

test('readTable: U+2028, U+2029 e \\r crudi dentro un campo non chiudono la riga', async (t) => {
  // COPY protegge solo \b \f \n \r \t \v e la barra: questi due caratteri arrivano crudi
  const file = scrivi(t, '1\tLine Sep\t10\tn\n2\tPara Sep\t10\t \n3\tcr\rraw\t10\tn\n');
  const righe = [];
  const r = await readTable({
    file,
    table: 'demo',
    columns: colonne,
    pick: ['id', 'name', 'note'],
    where: { column: 'group', values: new Set([10]) },
    onRow: (riga) => righe.push(riga),
  });
  assert.deepEqual(r, { rows: 3, kept: 3 });
  assert.deepEqual(righe, [
    { id: '1', name: 'Line Sep', note: 'n' },
    { id: '2', name: 'Para Sep', note: ' ' },
    { id: '3', name: 'cr\rraw', note: 'n' },
  ]);
});

test('readTable: righe e caratteri di più byte a cavallo dei blocchi da 1 MiB', async (t) => {
  // Righe lunghe di caratteri da 2, 3 e 4 byte: i confini dei blocchi cadono per forza a metà
  // di un carattere e a metà di una riga. L'ultima riga non ha il \n finale.
  const nomi = [];
  let testo = '';
  for (let i = 0; i < 40; i++) {
    const nome = `${'é'.repeat(20000 + i)}${'音'.repeat(15000 + i)}${'🎬'.repeat(10000 + i)} ${i}`;
    nomi.push(nome);
    testo += `${i}\t${nome}\t1\tn${i < 39 ? '\n' : ''}`;
  }
  const byte = Buffer.from(testo);
  assert.ok(byte.length > 3 * (1 << 20));
  // almeno un confine cade su un byte di continuazione (10xxxxxx), cioè dentro un carattere
  assert.ok([1, 2, 3].some((k) => (byte[k * (1 << 20)] & 0xc0) === 0x80));
  const file = scrivi(t, testo);
  const righe = [];
  const r = await readTable({ file, table: 'demo', columns: colonne, pick: ['id', 'name'], onRow: (x) => righe.push(x) });
  assert.deepEqual(r, { rows: 40, kept: 40 });
  assert.deepEqual(
    righe,
    nomi.map((name, i) => ({ id: String(i), name })),
  );
});

test('readTable: una riga più lunga di un blocco intero', async (t) => {
  // circa 4 MiB senza \n: la coda resta in sospeso per più blocchi di fila
  const lungo = 'x'.repeat(2 << 20) + 'ü'.repeat((1 << 20) + 3);
  const file = scrivi(t, `1\t${lungo}\t1\tn\n2\tb\t1\tn\n`);
  const righe = [];
  const r = await readTable({ file, table: 'demo', columns: colonne, pick: ['id', 'name'], onRow: (x) => righe.push(x) });
  assert.deepEqual(r, { rows: 2, kept: 2 });
  assert.equal(righe[0].name, lungo);
  assert.deepEqual(righe[1], { id: '2', name: 'b' });
});

test('readTable: righe vuote contano e fermano la lettura come le altre', async (t) => {
  const file = scrivi(t, '1\ta\t1\tn\n\n2\tb\t1\tn\n');
  await assert.rejects(
    readTable({ file, table: 'demo', columns: colonne, pick: ['id'], onRow: () => {} }),
    /demo: line 2 has 1 fields/,
  );
});

test('readTable: file vuoto e colonna sconosciuta', async (t) => {
  const vuoto = scrivi(t, '');
  assert.deepEqual(
    await readTable({ file: vuoto, table: 'demo', columns: colonne, pick: ['id'], onRow: () => {} }),
    { rows: 0, kept: 0 },
  );
  assert.throws(
    () => readTable({ file: vuoto, table: 'demo', columns: colonne, pick: ['nope'], onRow: () => {} }),
    /no column nope/,
  );
  await assert.rejects(
    readTable({ file: join(vuoto, '..', 'missing'), table: 'demo', columns: colonne, pick: ['id'], onRow: () => {} }),
    /ENOENT/,
  );
});
