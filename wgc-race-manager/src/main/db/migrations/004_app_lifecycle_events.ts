/**
 * 起動・正常終了・スリープ／復帰の記録（決定 D-064, D-066）。
 *
 * - 追記専用（UPDATE・DELETE はトリガーで拒否）
 * - 操作履歴（operation_history）・UNDO とは無関係の独立したテーブル
 * - 既存テーブルは変更しない
 */
export const migration004 = `
CREATE TABLE app_lifecycle_events (
  id              INTEGER PRIMARY KEY,
  boot_session_id TEXT    NOT NULL REFERENCES app_sessions(id),
  kind            TEXT    NOT NULL CHECK (kind IN ('BOOT','CLEAN_SHUTDOWN','SUSPEND','RESUME')),
  at              INTEGER NOT NULL,
  wall_at         INTEGER NOT NULL,
  mono_ms         REAL,
  drift_ms        INTEGER,
  anomaly         INTEGER NOT NULL DEFAULT 0 CHECK (anomaly IN (0,1)),
  detail          TEXT,
  created_at      INTEGER NOT NULL
);
CREATE INDEX idx_app_lifecycle_events_session ON app_lifecycle_events(boot_session_id, id);

CREATE TRIGGER trg_app_lifecycle_events_no_update BEFORE UPDATE ON app_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'app_lifecycle_events is append-only');
END;
CREATE TRIGGER trg_app_lifecycle_events_no_delete BEFORE DELETE ON app_lifecycle_events
BEGIN
  SELECT RAISE(ABORT, 'physical delete is forbidden on app_lifecycle_events');
END;
`
