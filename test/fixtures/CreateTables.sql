-- Synthetic fixture schema for the tests (written for this repository, not copied): the 17 tables
-- the builder reads, with the column names in the dump's order, plus constructs the parser must
-- survive: comments with commas, (parentheses); multi-line CHECKs; E'' strings; table constraints;
-- partitions; commented-out tables.
-- CREATE TABLE commented_out (should_not, appear INTEGER);
BEGIN;

/* CREATE TABLE in_block_comment (nope INTEGER); */

CREATE TABLE artist ( -- fixture, columns in dump order
    id INTEGER NOT NULL,
    gid UUID,
    name TEXT,
    sort_name TEXT,
    begin_date_year INTEGER,
    begin_date_month INTEGER,
    begin_date_day INTEGER,
    end_date_year INTEGER,
    end_date_month INTEGER,
    end_date_day INTEGER,
    type INTEGER,
    area INTEGER,
    gender INTEGER,
    comment TEXT,
    edits_pending INTEGER,
    last_updated INTEGER,
    ended BOOLEAN NOT NULL DEFAULT FALSE
      CONSTRAINT fixture_ended_check CHECK (
        (ended = TRUE OR
         end_date_year IS NULL) AND
        (begin_area IS NULL OR begin_area > 0)
      ),
    begin_area INTEGER,
    end_area INTEGER
);

CREATE TABLE artist_credit ( -- fixture, columns in dump order
    id INTEGER,
    name TEXT,
    artist_count INTEGER,
    ref_count INTEGER,
    created INTEGER,
    edits_pending INTEGER,
    gid UUID
);

CREATE TABLE artist_credit_name ( -- fixture, columns in dump order
    artist_credit INTEGER,
    position INTEGER,
    artist INTEGER,
    name TEXT,
    join_phrase TEXT
);

CREATE TABLE l_release_group_url ( -- fixture, columns in dump order
    id INTEGER,
    link INTEGER,
    entity0 INTEGER,
    entity1 INTEGER,
    edits_pending INTEGER,
    last_updated INTEGER,
    link_order INTEGER,
    entity0_credit INTEGER,
    entity1_credit INTEGER
);

CREATE TABLE link ( -- fixture, columns in dump order
    id INTEGER,
    link_type INTEGER,
    begin_date_year INTEGER,
    begin_date_month INTEGER,
    begin_date_day INTEGER,
    end_date_year INTEGER,
    end_date_month INTEGER,
    end_date_day INTEGER,
    attribute_count INTEGER,
    created INTEGER,
    ended BOOLEAN NOT NULL DEFAULT FALSE
      CONSTRAINT fixture_link_check CHECK (
        ended = FALSE OR
        attribute_count >= 0
      )
);

CREATE TABLE link_type ( -- fixture, columns in dump order
    id INTEGER,
    parent INTEGER,
    child_order INTEGER,
    gid UUID,
    entity_type0 INTEGER,
    entity_type1 INTEGER,
    name TEXT,
    description TEXT,
    link_phrase TEXT,
    reverse_link_phrase TEXT,
    long_link_phrase TEXT,
    last_updated INTEGER,
    is_deprecated INTEGER,
    has_dates INTEGER,
    entity0_cardinality INTEGER,
    entity1_cardinality INTEGER
);

CREATE TABLE medium ( -- fixture, columns in dump order
    id INTEGER,
    release INTEGER,
    position INTEGER,
    format INTEGER,
    name TEXT,
    edits_pending INTEGER,
    last_updated INTEGER,
    track_count INTEGER,
    gid UUID
);

CREATE TABLE release ( -- fixture, columns in dump order
    id INTEGER,
    gid UUID,
    name TEXT,
    artist_credit INTEGER,
    release_group INTEGER,
    status INTEGER,
    packaging INTEGER,
    language INTEGER,
    script INTEGER,
    barcode TEXT CHECK (barcode IS NULL OR barcode <> E'it\'s, (not) a code'),
    comment TEXT,
    edits_pending INTEGER,
    quality INTEGER,
    last_updated INTEGER
);

CREATE TABLE release_country ( -- fixture, columns in dump order
    release INTEGER,
    country INTEGER,
    date_year INTEGER,
    date_month INTEGER,
    date_day INTEGER,
    CONSTRAINT fixture_country_key UNIQUE (release, country)
);

CREATE TABLE release_unknown_country ( -- fixture, columns in dump order
    release INTEGER,
    date_year INTEGER,
    date_month INTEGER,
    date_day INTEGER
);

CREATE TABLE release_group ( -- fixture, columns in dump order
    id INTEGER,
    gid UUID,
    name TEXT,
    artist_credit INTEGER,
    type INTEGER,
    comment TEXT,
    edits_pending INTEGER,
    last_updated INTEGER
);

CREATE TABLE release_group_primary_type ( -- fixture, columns in dump order
    id INTEGER,
    name TEXT,
    parent INTEGER,
    child_order INTEGER,
    description TEXT,
    gid UUID
);

CREATE TABLE release_group_secondary_type ( -- fixture, columns in dump order
    id INTEGER,
    name TEXT,
    parent INTEGER,
    child_order INTEGER,
    description TEXT,
    gid UUID
);

CREATE TABLE release_group_secondary_type_join ( -- fixture, columns in dump order
    release_group INTEGER,
    secondary_type INTEGER,
    created INTEGER
);

CREATE TABLE release_status ( -- fixture, columns in dump order
    id INTEGER,
    name TEXT,
    parent INTEGER,
    child_order INTEGER,
    description TEXT,
    gid UUID
);

CREATE TABLE track ( -- fixture, columns in dump order
    id INTEGER,
    gid UUID,
    recording INTEGER,
    medium INTEGER,
    position INTEGER,
    number TEXT,
    name TEXT,
    artist_credit INTEGER,
    length INTEGER,
    edits_pending INTEGER,
    last_updated INTEGER,
    is_data_track INTEGER
);

CREATE TABLE url ( -- fixture, columns in dump order
    id INTEGER,
    gid UUID,
    url TEXT,
    edits_pending INTEGER,
    last_updated INTEGER
);

CREATE TABLE track_partition_example
    PARTITION OF track FOR VALUES IN (TRUE);

COMMIT;
