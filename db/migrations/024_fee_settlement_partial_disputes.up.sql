ALTER TABLE fee_settlements
  DROP CONSTRAINT fee_settlements_status_check,
  ADD CONSTRAINT fee_settlements_status_check
    CHECK (status IN ('pending', 'confirmed', 'expired', 'disputed')),
  ADD COLUMN submission_error TEXT;

CREATE TABLE fee_settlement_items (
  settlement_id UUID NOT NULL REFERENCES fee_settlements(id) ON DELETE CASCADE,
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  amount NUMERIC(18, 7) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (settlement_id, payment_id)
);

INSERT INTO fee_settlement_items (settlement_id, payment_id, amount)
SELECT fee_settlement_id, id, fee_owed_raw
FROM payments
WHERE fee_settlement_id IS NOT NULL
  AND fee_status IN ('claimed', 'settled')
  AND fee_owed_raw IS NOT NULL
  AND fee_owed_raw > 0;

CREATE INDEX fee_settlements_failed_created_idx
  ON fee_settlements(created_at)
  WHERE status = 'failed';