// Lettura delle tabelle del dump: formato testo di `COPY ... TO STDOUT` di PostgreSQL.
//
// Una riga per record, campi separati da tab, `\N` per NULL; tab, a capo e barre rovesciate
// dentro i valori arrivano protetti (`\t`, `\n`, `\\`). Le tabelle grandi (track ha decine di
// milioni di righe) si leggono a flusso e con un filtro veloce su una colonna intera, così si
// decodificano solo le righe che servono.
//
// Le righe si separano solo sul byte `\n`, il terminatore che COPY TO scrive. Niente readline:
// chiude la riga anche su `\r`, U+2028 e U+2029, e COPY lascia crudi gli ultimi due, quindi un
// titolo che li contiene spezzerebbe la riga in due e fermerebbe tutto con un falso
// «schema changed».

import { createReadStream } from 'node:fs';

/** Valore che COPY scrive per NULL. */
const NULLO = '\\N';

/** Byte di fine riga. */
const A_CAPO = 0x0a;

/**
 * Decodifica un campo nel formato testo di COPY.
 * @param {string} grezzo
 * @returns {string | null}
 */
export function decodeField(grezzo) {
  if (grezzo === NULLO) return null;
  if (!grezzo.includes('\\')) return grezzo;
  let fuori = '';
  for (let i = 0; i < grezzo.length; i++) {
    const c = grezzo[i];
    if (c !== '\\') {
      fuori += c;
      continue;
    }
    i++;
    const d = grezzo[i];
    switch (d) {
      case 'b':
        fuori += '\b';
        break;
      case 'f':
        fuori += '\f';
        break;
      case 'n':
        fuori += '\n';
        break;
      case 'r':
        fuori += '\r';
        break;
      case 't':
        fuori += '\t';
        break;
      case 'v':
        fuori += '\v';
        break;
      case undefined:
        throw new Error('COPY text: backslash at the end of a field');
      default:
        // COPY TO non scrive mai sequenze ottali o esadecimali (sono byte, non caratteri):
        // se compaiono il formato non è quello atteso e ci si ferma.
        if (/[0-7x]/.test(d)) throw new Error(`COPY text: unexpected escape \\${d}`);
        // `\\` e qualsiasi altro carattere protetto valgono il carattere stesso.
        fuori += d;
    }
  }
  return fuori;
}

/** Errore per una riga con un numero di campi diverso da quello dello schema. */
export class FieldCountError extends Error {
  constructor(tabella, riga, attesi, trovati) {
    super(
      `${tabella}: line ${riga} has ${trovati} fields, CreateTables.sql declares ${attesi}` +
        ' (schema changed? stopping without building)',
    );
    this.name = 'FieldCountError';
  }
}

/**
 * Legge una tabella del dump riga per riga.
 *
 * Ogni riga deve avere esattamente il numero di campi dello schema, altrimenti si ferma con
 * `FieldCountError`. Con `where` una riga passa solo se il valore intero di quella colonna è
 * nell'insieme (un `\N` non passa mai).
 *
 * @param {object} o
 * @param {string} o.file percorso del file
 * @param {string} o.table nome della tabella (per i messaggi)
 * @param {string[]} o.columns tutte le colonne, nell'ordine di CreateTables.sql
 * @param {string[]} o.pick colonne da restituire
 * @param {{ column: string, values: { has(v: number): boolean } }} [o.where]
 * @param {(row: Record<string, string | null>) => void} o.onRow
 * @returns {Promise<{ rows: number, kept: number }>}
 */
export function readTable({ file, table, columns, pick, where, onRow }) {
  const tabAttesi = columns.length - 1;
  const indice = (nome) => {
    const i = columns.indexOf(nome);
    if (i < 0) throw new Error(`${table}: no column ${nome}`);
    return i;
  };
  const scelte = pick.map((nome) => [nome, indice(nome)]);
  const filtro = where ? indice(where.column) : -1;
  // inizi[k] = posizione del primo carattere del campo k; inizi[k + 1] - 1 = la sua fine.
  const inizi = new Int32Array(columns.length + 1);
  let numero = 0;
  let tenute = 0;

  /** Una riga già decodificata, senza il `\n` finale. */
  const riga = (testo) => {
    numero++;
    let tab = 0;
    let p = testo.indexOf('\t');
    while (p !== -1) {
      tab++;
      if (tab > tabAttesi) break;
      inizi[tab] = p + 1;
      p = testo.indexOf('\t', p + 1);
    }
    if (tab !== tabAttesi) {
      // per il messaggio conta tutti i campi, anche oltre quelli attesi
      const trovati = testo.split('\t').length;
      throw new FieldCountError(table, numero, columns.length, trovati);
    }
    inizi[0] = 0;
    inizi[columns.length] = testo.length + 1;
    if (filtro >= 0) {
      const valore = testo.slice(inizi[filtro], inizi[filtro + 1] - 1);
      if (valore === NULLO || !where.values.has(Number(valore))) return;
    }
    const record = {};
    for (const [nome, i] of scelte) record[nome] = decodeField(testo.slice(inizi[i], inizi[i + 1] - 1));
    tenute++;
    onRow(record);
  };

  /** Righe complete di un blocco di testo che finisce con l'ultimo `\n` (escluso). */
  const righe = (testo) => {
    let inizio = 0;
    let fine = testo.indexOf('\n');
    while (fine !== -1) {
      riga(testo.slice(inizio, fine));
      inizio = fine + 1;
      fine = testo.indexOf('\n', inizio);
    }
    riga(testo.slice(inizio));
  };

  const leggi = async () => {
    // Si lavora sui byte: il `\n` (0x0A) non compare mai dentro un carattere UTF-8 di più byte,
    // quindi tagliare sull'ultimo `\n` di un blocco non spezza mai un carattere. La coda dopo
    // l'ultimo `\n` resta in byte e si unisce al blocco successivo.
    let coda = [];
    // con `break` o un errore il for await chiude il file
    for await (const blocco of createReadStream(file, { highWaterMark: 1 << 20 })) {
      const ultimo = blocco.lastIndexOf(A_CAPO);
      if (ultimo === -1) {
        coda.push(blocco);
        continue;
      }
      const testa = blocco.subarray(0, ultimo);
      righe((coda.length === 0 ? testa : Buffer.concat([...coda, testa])).toString('utf8'));
      coda = ultimo + 1 < blocco.length ? [blocco.subarray(ultimo + 1)] : [];
    }
    // ultima riga senza `\n` finale
    if (coda.length > 0) riga(Buffer.concat(coda).toString('utf8'));
    return { rows: numero, kept: tenute };
  };

  return leggi();
}

/**
 * Intero da un campo decodificato (`null` resta `null`).
 * @param {string | null} valore
 */
export function int(valore) {
  if (valore === null) return null;
  if (!/^-?\d+$/.test(valore)) throw new Error(`expected an integer, got ${JSON.stringify(valore)}`);
  return Number(valore);
}

/**
 * Booleano di PostgreSQL (`t` / `f`).
 * @param {string | null} valore
 */
export function bool(valore) {
  if (valore === 't') return true;
  if (valore === 'f') return false;
  throw new Error(`expected t or f, got ${JSON.stringify(valore)}`);
}
