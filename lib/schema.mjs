// Ordine delle colonne delle tabelle MusicBrainz, letto da admin/sql/CreateTables.sql.
//
// I file del dump sono l'uscita di `COPY tabella TO STDOUT`, con le colonne nell'ordine di
// CreateTables.sql (gli strumenti di MetaBrainz li reimportano con `COPY ... FROM` senza
// elenco di colonne). Lo leggiamo a ogni costruzione invece di scriverlo a mano: se lo
// schema cambia, il numero di campi non torna e il robot si ferma, invece di produrre dati
// spostati di colonna.

/** Parole che aprono un vincolo di tabella invece di una colonna. */
const NON_COLONNE = new Set(['constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like']);

/**
 * Fine della stringa SQL che si apre in `inizio` (un apice). Nelle stringhe E'...' la barra
 * rovesciata protegge il carattere dopo; in tutte, due apici di fila sono un apice.
 */
function fineStringa(sql, inizio) {
  const prima = sql[inizio - 1] ?? '';
  const primaAncora = sql[inizio - 2] ?? '';
  const conEscape = (prima === 'E' || prima === 'e') && !/[A-Za-z0-9_]/.test(primaAncora);
  let i = inizio + 1;
  for (;;) {
    if (i >= sql.length) throw new Error('CreateTables.sql: unterminated string literal');
    const c = sql[i];
    if (conEscape && c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      if (sql[i + 1] === "'") {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
}

/** Fine dell'identificatore fra virgolette che si apre in `inizio`. */
function fineIdentificatore(sql, inizio) {
  let i = inizio + 1;
  for (;;) {
    if (i >= sql.length) throw new Error('CreateTables.sql: unterminated quoted identifier');
    if (sql[i] === '"') {
      if (sql[i + 1] === '"') {
        i += 2;
        continue;
      }
      return i;
    }
    i++;
  }
}

/** Toglie i commenti (`-- ...` e `/* ... *\/`) lasciando intatte stringhe e identificatori. */
export function stripSqlComments(sql) {
  const pezzi = [];
  let da = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      pezzi.push(sql.slice(da, i));
      const a = sql.indexOf('\n', i);
      i = a < 0 ? sql.length : a;
      da = i;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      pezzi.push(sql.slice(da, i), ' ');
      const a = sql.indexOf('*/', i + 2);
      if (a < 0) throw new Error('CreateTables.sql: unterminated block comment');
      i = a + 2;
      da = i;
      continue;
    }
    if (c === "'") {
      i = fineStringa(sql, i) + 1;
      continue;
    }
    if (c === '"') {
      i = fineIdentificatore(sql, i) + 1;
      continue;
    }
    i++;
  }
  pezzi.push(sql.slice(da));
  return pezzi.join('');
}

/**
 * Divide il corpo fra parentesi che si apre in `aperta` nelle voci separate da virgole al
 * primo livello. Ritorna le voci e la posizione della parentesi che chiude.
 */
function vociFraParentesi(sql, aperta) {
  const voci = [];
  let profondita = 0;
  let da = aperta + 1;
  for (let i = aperta; i < sql.length; i++) {
    const c = sql[i];
    if (c === "'") {
      i = fineStringa(sql, i);
    } else if (c === '"') {
      i = fineIdentificatore(sql, i);
    } else if (c === '(') {
      profondita++;
    } else if (c === ')') {
      profondita--;
      if (profondita === 0) {
        voci.push(sql.slice(da, i));
        return { voci, chiusa: i };
      }
    } else if (c === ',' && profondita === 1) {
      voci.push(sql.slice(da, i));
      da = i + 1;
    }
  }
  throw new Error('CreateTables.sql: unbalanced parentheses');
}

/** Nome senza virgolette e senza schema (`musicbrainz.track` → `track`). */
function nomeSemplice(nome) {
  const ultimo = nome.split('.').pop();
  return ultimo.startsWith('"') ? ultimo.slice(1, -1).replaceAll('""', '"') : ultimo.toLowerCase();
}

/**
 * Legge tutte le CREATE TABLE di uno script SQL.
 * @param {string} sql testo di CreateTables.sql
 * @returns {Map<string, string[]>} tabella → colonne nell'ordine dichiarato
 */
export function parseCreateTables(sql) {
  const testo = stripSqlComments(sql);
  const tabelle = new Map();
  const creaTabella =
    /\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*))?)\s*\(/gi;
  let trovata;
  while ((trovata = creaTabella.exec(testo))) {
    const nome = nomeSemplice(trovata[1]);
    const aperta = creaTabella.lastIndex - 1;
    const { voci, chiusa } = vociFraParentesi(testo, aperta);
    const colonne = [];
    for (const voce of voci) {
      const parola = /^\s*("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)/.exec(voce);
      if (!parola) continue;
      if (NON_COLONNE.has(parola[1].toLowerCase())) continue;
      colonne.push(nomeSemplice(parola[1]));
    }
    if (tabelle.has(nome)) throw new Error(`CreateTables.sql: table ${nome} is defined twice`);
    tabelle.set(nome, colonne);
    creaTabella.lastIndex = chiusa + 1;
  }
  return tabelle;
}

/**
 * Colonne di una tabella, con il controllo che ci siano quelle che servono.
 * @param {Map<string, string[]>} schema
 * @param {string} tabella
 * @param {string[]} servono
 */
export function tableColumns(schema, tabella, servono = []) {
  const colonne = schema.get(tabella);
  if (!colonne) throw new Error(`CreateTables.sql: table ${tabella} not found`);
  for (const colonna of servono) {
    if (!colonne.includes(colonna)) {
      throw new Error(`CreateTables.sql: table ${tabella} has no column ${colonna}`);
    }
  }
  return colonne;
}
