import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { DUMP_TABLES, checkSchema } from '../lib/collect.mjs';
import { parseCreateTables, stripSqlComments, tableColumns } from '../lib/schema.mjs';
import { FIXTURE_SCHEMA } from './helpers.mjs';

const schema = parseCreateTables(readFileSync(FIXTURE_SCHEMA, 'utf8'));

test('legge le 17 tabelle della fixture e nient’altro', () => {
  assert.deepEqual([...schema.keys()].sort(), [...DUMP_TABLES].sort());
});

test('ordine delle colonne come in CreateTables.sql', () => {
  assert.deepEqual(schema.get('track'), [
    'id', 'gid', 'recording', 'medium', 'position', 'number', 'name',
    'artist_credit', 'length', 'edits_pending', 'last_updated', 'is_data_track',
  ]);
  assert.deepEqual(schema.get('release_group_secondary_type_join'), ['release_group', 'secondary_type', 'created']);
});

test('i CHECK su più righe non diventano colonne', () => {
  assert.equal(schema.get('artist').length, 19);
  assert.deepEqual(schema.get('artist').slice(-3), ['ended', 'begin_area', 'end_area']);
  assert.equal(schema.get('link').length, 11);
  assert.equal(schema.get('link').at(-1), 'ended');
});

test('stringhe E con apice protetto, virgole e parentesi', () => {
  assert.equal(schema.get('release').length, 14);
  assert.equal(schema.get('release')[9], 'barcode');
  assert.equal(schema.get('release_group').length, 8);
});

test('un vincolo di tabella non è una colonna', () => {
  assert.deepEqual(schema.get('release_country'), ['release', 'country', 'date_year', 'date_month', 'date_day']);
});

test('commenti e partizioni non creano tabelle', () => {
  assert.equal(schema.has('commented_out'), false);
  assert.equal(schema.has('in_block_comment'), false);
  assert.equal(schema.has('track_partition_example'), false);
});

test('«--» dentro una stringa non è un commento', () => {
  const s = parseCreateTables("CREATE TABLE t (a TEXT DEFAULT '--x', b INTEGER -- c, d\n);");
  assert.deepEqual(s.get('t'), ['a', 'b']);
  assert.equal(stripSqlComments("x '--y' -- z\nw"), "x '--y' \nw");
});

test('identificatori fra virgolette e nomi con schema', () => {
  const s = parseCreateTables('CREATE TABLE musicbrainz."Odd" ("first col" INT, Second INT);');
  assert.deepEqual(s.get('Odd'), ['first col', 'second']);
});

test('una tabella definita due volte è un errore', () => {
  assert.throws(() => parseCreateTables('CREATE TABLE t (a INT); CREATE TABLE t (b INT);'), /defined twice/);
});

test('tableColumns e checkSchema segnalano tabelle e colonne mancanti', () => {
  assert.throws(() => tableColumns(schema, 'recording'), /table recording not found/);
  assert.throws(() => tableColumns(schema, 'track', ['nope']), /track has no column nope/);
  checkSchema(schema);
  const senzaColonna = new Map(schema);
  senzaColonna.set('medium', schema.get('medium').filter((c) => c !== 'track_count'));
  assert.throws(() => checkSchema(senzaColonna), /medium has no column track_count/);
});
