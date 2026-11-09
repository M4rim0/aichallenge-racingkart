/**
 * 起動セッションの記録と PC 時刻異常の識別（D-013）。
 *
 * - app_sessions：アプリの起動ごとに 1 行。起動時の PC 実日時と、その時点で DB に保存されていた最新日時を記録し、
 *   PC 時刻が過去に戻っていた場合は clock_anomaly = 1 とする。追記専用。
 * - operation_history.boot_session_id：どの起動セッションで行われた操作かを識別する。
 *   通過記録・時計遷移は 001 で boot_session_id を保持済み。
 */
export const migration002 = `
CREATE TABLE app_sessions (
  id                     TEXT    PRIMARY KEY,
  started_wall_at        INTEGER NOT NULL,
  latest_saved_at_before INTEGER,
  clock_anomaly          INTEGER NOT NULL DEFAULT 0 CHECK (clock_anomaly IN (0,1)),
  anomaly_detail         TEXT,
  app_version            TEXT,
  created_at             INTEGER NOT NULL
);

CREATE TRIGGER trg_app_sessions_no_update BEFORE UPDATE ON app_sessions
BEGIN
  SELECT RAISE(ABORT, 'app_sessions is append-only');
END;
CREATE TRIGGER trg_app_sessions_no_delete BEFORE DELETE ON app_sessions
BEGIN
  SELECT RAISE(ABORT, 'physical delete is forbidden on app_sessions; use logical delete');
END;

ALTER TABLE operation_history ADD COLUMN boot_session_id TEXT;
`
