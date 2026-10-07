# Filmdock soundtrack pack

A small, signed SQLite pack of film and TV soundtrack albums, keyed by IMDb title id, built
every week from the public [MusicBrainz](https://musicbrainz.org) database export.

The Filmdock desktop app downloads the pack about once a week and reads it locally (also
offline) to show the soundtrack albums of the films and series in a user's library. The app
never asks anyone about a single title: everyone gets the same file, so nobody learns which
films a user has.

## Data and licence

- **Source**: the MusicBrainz full export on
  [data.metabrainz.org](https://data.metabrainz.org/pub/musicbrainz/data/fullexport/), file
  `mbdump.tar.bz2`, which holds the MusicBrainz **core data**, released under
  [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). The pack is CC0 as well.
- **Core data only.** The builder never downloads or reads tags, genres, ratings,
  annotations or search data (those are licensed CC BY-NC-SA and live in other files).
- **Dump files only.** The MusicBrainz web service (`/ws/2`) is never used.
- **No cover art** and **no listening links**: only album names, artists, years, track titles
  and lengths.
- Only **official** releases are used: no bootlegs, promos or pseudo-releases.
- This project is **not affiliated with or endorsed by** MusicBrainz or the MetaBrainz
  Foundation. If the data is useful to you, consider
  [supporting MetaBrainz](https://metabrainz.org/donate).

## What goes in

A release group enters the pack when it has:

- primary type **Album** and secondary type **Soundtrack** (other secondary types may be
  present too);
- at least one **IMDb** relationship (link type `85b0a010-3237-47c7-8476-6fcefd4761af`) to a
  URL matching `^https?://(www\.|m\.)?imdb\.com/title/tt(\d{7,10})/?$`;
- at least one **Official** release with tracks.

For each album:

- `year` is the year of its first official release (earliest date across
  `release_country` and `release_unknown_country`; a missing year, month or day sorts after
  any known one);
- the tracks come from the earliest official release that has tracks (same date: lowest
  id), all media in order (`medium.position`, then `track.position`), without data tracks;
- a track's `artist` is set only when its artist credit differs from the album's;
- `various` is 1 when the album's artist credit includes Various Artists
  (`89ad4ac3-39f7-470e-963a-56509c546377`);
- nothing is made up: a missing value stays `NULL`.

## Release assets

Each release is tagged `pack-<dump>` (for example `pack-20261007-002147`) and has three
assets. The latest one is always at stable URLs:

```text
https://github.com/filmdock/soundtrack/releases/latest/download/soundtrack.json
https://github.com/filmdock/soundtrack/releases/latest/download/soundtrack.json.sig
https://github.com/filmdock/soundtrack/releases/latest/download/soundtrack.sqlite.gz
```

- `soundtrack.sqlite.gz` — the SQLite database, gzip-compressed.
- `soundtrack.json` — the manifest, compact UTF-8 JSON with the keys in this order and no
  trailing newline:

  ```json
  {"format":1,"dump":"20261007-002147","built":"2026-10-08T06:31:02Z","file":"soundtrack.sqlite.gz","size":12345678,"sha256":"<lowercase hex SHA-256 of the .gz>","albums":1234,"titles":1234}
  ```

  `titles` is the number of distinct IMDb titles.
- `soundtrack.json.sig` — the raw 64-byte **Ed25519** signature of the exact bytes of
  `soundtrack.json`.

Only the last four releases are kept.

## Format 1

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;   -- format='1', dump, built
CREATE TABLE album (
  id INTEGER PRIMARY KEY,          -- dense, 1..N
  mbid TEXT NOT NULL,              -- release group MBID
  title TEXT NOT NULL,             -- release group name as on MusicBrainz
  artist TEXT NOT NULL,            -- release group artist credit (string)
  various INTEGER NOT NULL,        -- 1 if the artist is Various Artists
  year INTEGER,                    -- year of the first official release
  release_mbid TEXT NOT NULL       -- release the tracks come from
);
CREATE TABLE track (
  album INTEGER NOT NULL,
  n INTEGER NOT NULL,              -- 1..: order across all media
  title TEXT NOT NULL,
  artist TEXT,                     -- NULL when equal to the album artist
  length_ms INTEGER,               -- NULL when unknown
  PRIMARY KEY (album, n)
) WITHOUT ROWID;
CREATE TABLE imdb (tt INTEGER NOT NULL, album INTEGER NOT NULL, PRIMARY KEY (tt, album)) WITHOUT ROWID;  -- tt = number in ttNNNNNNN
```

A reader must ignore a manifest whose `format` it does not know. Any change to the schema
gets a new format number.

## Verifying a pack

The public key is in [`public-key.txt`](public-key.txt): the 32 raw bytes of the Ed25519
key, base64 (44 characters).

With Node.js 24, from a clone of this repository and a folder holding the three assets:

```sh
node verify.mjs --dir <folder> --deep
```

With OpenSSL 3 and a POSIX shell:

```sh
# public-key.txt → PEM (the 12 bytes are the DER prefix of an Ed25519 public key)
{ printf '\060\052\060\005\006\003\053\145\160\003\041\000'; base64 -d public-key.txt; } \
  | openssl pkey -pubin -inform DER -out public-key.pem
openssl pkeyutl -verify -rawin -pubin -inkey public-key.pem \
  -in soundtrack.json -sigfile soundtrack.json.sig
sha256sum soundtrack.sqlite.gz   # must equal "sha256" in soundtrack.json
```

## How it is built

[`.github/workflows/build.yml`](.github/workflows/build.yml) runs on Thursday and Sunday at
06:00 UTC, the day after the usual export days (Wednesday and Saturday), and on demand; when
there is no new export it stops after the first checks:

1. checks that the signing secret and `public-key.txt` are set, then runs the unit tests;
2. `node build.mjs` reads `LATEST`, stops if `pack-<dump>` is already published, downloads
   `mbdump.tar.bz2`, checks it against `SHA256SUMS`, extracts only the 17 tables it needs in
   one pass (`tar` + `lbzip2`), reads the column order from
   [`CreateTables.sql`](https://github.com/metabrainz/musicbrainz-server/blob/master/admin/sql/CreateTables.sql)
   and **stops if any row has a different number of fields**, streams the tables, writes
   and checks the SQLite file, gzips it and writes the manifest. It refuses to publish a pack
   with fewer than 1000 albums or more than 10% fewer than the previous build;
3. `scripts/sign.sh` signs the manifest with `openssl pkeyutl -sign -rawin`, using the
   `SOUNDTRACK_SIGNING_KEY` secret written to a temporary file (mode 600) and deleted right
   away; the key is never printed;
4. `node verify.mjs --deep` checks the signature against `public-key.txt` with a different
   implementation (Node's crypto), then size, SHA-256 and content of the pack;
5. the release is created as a draft with the three assets, then published as latest; older
   releases beyond the last four are deleted;
6. `last-build.json` is updated and committed (GitHub disables scheduled workflows in
   repositories without activity for 60 days).

Nothing unsigned is ever published: without the secret, with a placeholder public key or
with a signature that does not verify, the workflow stops before the release step.

The builder needs Node.js 24 and no npm packages (`node:sqlite`, `node:zlib`,
`node:crypto`), plus `curl`, `tar`, `lbzip2`, `openssl` and `gh`.
A build takes about 15-30 minutes and about 25 GB of disk (the 7.6 GB archive plus the
extracted tables); the runner uses its large `/mnt` disk.

### Running it locally

```sh
node --test "test/**/*.test.mjs"     # unit tests on small fake tables in test/fixtures
node build.mjs --skip-release-check --work /big/disk/work --out out
```

`node build.mjs --help` lists the options (for example `--decompressor bzip2` without
lbzip2, or `--tables-dir` to reuse already extracted tables).

### Signing key (maintainers)

```sh
openssl genpkey -algorithm ed25519 -out soundtrack-signing-key.pem
gh secret set SOUNDTRACK_SIGNING_KEY --repo filmdock/soundtrack < soundtrack-signing-key.pem
openssl pkey -in soundtrack-signing-key.pem -pubout -outform DER | tail -c 32 | base64   # → public-key.txt
```

Keep the private key offline and never commit it.
