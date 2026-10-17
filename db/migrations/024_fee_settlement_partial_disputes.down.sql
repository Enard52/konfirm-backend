DROP INDEX IF EXISTS fee_settlements_failed_created_idx;
DROP TABLE IF EXISTS fee_settlement_items;

UPDATE fee_settlements SET status = 'expired' WHERE status = 'disputed';
ALTER TABLE fee_settlements
  DROP CONSTRAINT fee_settlements_status_check,
  ADD CONSTRAINT fee_settlements_status_check
    CHECK (status IN ('pending', 'confirmed', 'expired')),
  DROP COLUMN submission_error;