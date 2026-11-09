/**
 * 異常終了後の復旧確認待ち（決定 D-070〜D-072）。
 *
 * - HOLD：異常終了後の起動時に、進行中だった大会ごとにシステムが追記する
 * - CONFIRM：操作者が復旧を確認したときに追記する（hold_id で HOLD を参照、1 つの HOLD に 1 件まで）
 * - 確認待ち = CONFIRM のない HOLD がある
 * - 追記専用（UPDATE・DELETE はトリガーで拒否）。時計・記録・操作履歴の既存行は一切変更しない
 */
export const migration005 = `
CREATE TABLE race_recovery_holds (
  id                     INTEGER PRIMARY KEY,
  event_id               INTEGER NOT NULL REFERENCES events(id),
  kind                   TEXT    NOT NULL CHECK (kind IN ('HOLD','CONFIRM')),
  hold_id                INTEGER REFERENCES race_recovery_holds(id),
  boot_session_id        TEXT    NOT NULL REFERENCES app_sessions(id),
  crashed_session_id     TEXT    REFERENCES app_sessions(id),
  event_status           TEXT    CHECK (event_status IS NULL OR event_status IN ('RUNNING','PAUSED')),
  operator_id            INTEGER REFERENCES operators(id),
  operator_name_snapshot TEXT,
  at                     INTEGER NOT NULL,
  wall_at                INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  CHECK ((kind = 'HOLD' AND hold_id IS NULL AND event_status IS NOT NULL)
      OR (kind = 'CONFIRM' AND hold_id IS NOT NULL))
);
CREATE INDEX idx_race_recovery_holds_event ON race_recovery_holds(event_id, id);
CREATE UNIQUE INDEX uq_race_recovery_holds_confirm ON race_recovery_holds(hold_id) WHERE kind = 'CONFIRM';

CREATE TRIGGER trg_race_recovery_holds_confirm_same_event BEFORE INSERT ON race_recovery_holds
WHEN NEW.kind = 'CONFIRM'
 AND (SELECT event_id FROM race_recovery_holds WHERE id = NEW.hold_id AND kind = 'HOLD') IS NOT NEW.event_id
BEGIN
  SELECT RAISE(ABORT, 'CONFIRM must reference a HOLD of the same event');
END;
CREATE TRIGGER trg_race_recovery_holds_no_update BEFORE UPDATE ON race_recovery_holds
BEGIN
  SELECT RAISE(ABORT, 'race_recovery_holds is append-only');
END;
CREATE TRIGGER trg_race_recovery_holds_no_delete BEFORE DELETE ON race_recovery_holds
BEGIN
  SELECT RAISE(ABORT, 'physical delete is forbidden on race_recovery_holds');
END;
`
