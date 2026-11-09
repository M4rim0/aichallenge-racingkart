/**
 * 初期スキーマ。
 *
 * 方針：
 * - 日時は UTC epoch ミリ秒（INTEGER）
 * - 削除は論理削除（deleted_at）。物理削除は全テーブルでトリガーにより拒否する
 * - 周回番号・ラップタイム・順位などの派生値は保存しない（D-005, 仕様 §14）
 * - 車両データは入力文字列のまま TEXT で保存（D-006）
 */

const PROTECTED_TABLES = [
  'events',
  'teams',
  'lap_records',
  'vehicle_data',
  'competitor_passes',
  'operators',
  'memos',
  'operation_history',
  'race_clock_transitions',
  'mandatory_stoppages'
] as const

const noPhysicalDeleteTriggers = PROTECTED_TABLES.map(
  (t) => `
CREATE TRIGGER trg_${t}_no_delete BEFORE DELETE ON ${t}
BEGIN
  SELECT RAISE(ABORT, 'physical delete is forbidden on ${t}; use logical delete');
END;`
).join('\n')

const sameEventTriggers = (['lap_records', 'competitor_passes'] as const)
  .map(
    (t) => `
CREATE TRIGGER trg_${t}_same_event_insert BEFORE INSERT ON ${t}
WHEN (SELECT event_id FROM teams WHERE id = NEW.team_id) IS NOT NEW.event_id
BEGIN
  SELECT RAISE(ABORT, 'team does not belong to the event (${t})');
END;
CREATE TRIGGER trg_${t}_same_event_update BEFORE UPDATE OF team_id, event_id ON ${t}
WHEN (SELECT event_id FROM teams WHERE id = NEW.team_id) IS NOT NEW.event_id
BEGIN
  SELECT RAISE(ABORT, 'team does not belong to the event (${t})');
END;`
  )
  .join('\n')

export const migration001 = `
CREATE TABLE events (
  id                 INTEGER PRIMARY KEY,
  name               TEXT    NOT NULL,
  held_on            TEXT,
  course_name        TEXT,
  lap_distance_m     REAL    CHECK (lap_distance_m IS NULL OR lap_distance_m > 0),
  scheduled_start_at INTEGER,
  scheduled_end_at   INTEGER,
  actual_start_at    INTEGER,
  actual_end_at      INTEGER,
  status             TEXT    NOT NULL DEFAULT 'PREPARING'
                     CHECK (status IN ('PREPARING','RUNNING','PAUSED','FINISHED')),
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER
);

CREATE TABLE teams (
  id          INTEGER PRIMARY KEY,
  event_id    INTEGER NOT NULL REFERENCES events(id),
  name        TEXT    NOT NULL,
  bib_number  TEXT,
  color       TEXT,
  is_own_team INTEGER NOT NULL DEFAULT 0 CHECK (is_own_team IN (0,1)),
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  deleted_at  INTEGER
);
CREATE INDEX idx_teams_event ON teams(event_id);
-- 1大会につき（削除されていない）自チームは1チームのみ
CREATE UNIQUE INDEX uq_teams_own_team ON teams(event_id)
  WHERE is_own_team = 1 AND deleted_at IS NULL;

CREATE TABLE lap_records (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  passed_at       INTEGER NOT NULL,
  passed_wall_at  INTEGER,
  boot_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX idx_lap_records_team_passed ON lap_records(team_id, passed_at);
CREATE INDEX idx_lap_records_event ON lap_records(event_id);

CREATE TABLE vehicle_data (
  id               INTEGER PRIMARY KEY,
  lap_record_id    INTEGER NOT NULL REFERENCES lap_records(id),
  speed            TEXT,
  voltage          TEXT,
  current          TEXT,
  integrated_value TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER
);
-- 1ラップにつき（削除されていない）車両データは1セット
CREATE UNIQUE INDEX uq_vehicle_data_lap ON vehicle_data(lap_record_id) WHERE deleted_at IS NULL;

CREATE TABLE competitor_passes (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  team_id         INTEGER NOT NULL REFERENCES teams(id),
  passed_at       INTEGER NOT NULL,
  passed_wall_at  INTEGER,
  boot_session_id TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  deleted_at      INTEGER
);
CREATE INDEX idx_competitor_passes_team_passed ON competitor_passes(team_id, passed_at);
CREATE INDEX idx_competitor_passes_event ON competitor_passes(event_id);

CREATE TABLE operators (
  id         INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE memos (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  body       TEXT    NOT NULL,
  noted_at   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_memos_event ON memos(event_id, noted_at);

CREATE TABLE operation_history (
  id                     INTEGER PRIMARY KEY,
  event_id               INTEGER REFERENCES events(id),
  operator_id            INTEGER REFERENCES operators(id),
  operator_name_snapshot TEXT,
  operated_at            INTEGER NOT NULL,
  action                 TEXT    NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE','UNDO')),
  target_table           TEXT    NOT NULL,
  target_id              INTEGER,
  before_json            TEXT,
  after_json             TEXT,
  undo_of_history_id     INTEGER REFERENCES operation_history(id),
  note                   TEXT
);
CREATE INDEX idx_operation_history_event ON operation_history(event_id, id);

CREATE TABLE race_clock_transitions (
  id              INTEGER PRIMARY KEY,
  event_id        INTEGER NOT NULL REFERENCES events(id),
  kind            TEXT    NOT NULL CHECK (kind IN ('START','PAUSE','RESUME','END')),
  at              INTEGER NOT NULL,
  wall_at         INTEGER NOT NULL,
  mono_ms         REAL,
  boot_session_id TEXT    NOT NULL,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_race_clock_transitions_event ON race_clock_transitions(event_id, id);

CREATE TABLE mandatory_stoppages (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  starts_at  INTEGER NOT NULL,
  ends_at    INTEGER CHECK (ends_at IS NULL OR ends_at >= starts_at),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_mandatory_stoppages_event ON mandatory_stoppages(event_id);

-- 追記専用テーブル：更新を拒否する
CREATE TRIGGER trg_operation_history_no_update BEFORE UPDATE ON operation_history
BEGIN
  SELECT RAISE(ABORT, 'operation_history is append-only');
END;
CREATE TRIGGER trg_race_clock_transitions_no_update BEFORE UPDATE ON race_clock_transitions
BEGIN
  SELECT RAISE(ABORT, 'race_clock_transitions is append-only');
END;
${noPhysicalDeleteTriggers}
${sameEventTriggers}
`
