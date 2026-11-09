/**
 * 操作単位のグループ化（D-017：UNDO）。
 * 1 回のユーザー操作で複数の履歴行が作られる場合に、まとめて取り消せるようにする。
 * 既存行（NULL）は 1 行 = 1 操作として扱う。
 */
export const migration003 = `
ALTER TABLE operation_history ADD COLUMN operation_group TEXT;
CREATE INDEX idx_operation_history_group ON operation_history(operation_group);
CREATE INDEX idx_operation_history_undo_of ON operation_history(undo_of_history_id);
`
