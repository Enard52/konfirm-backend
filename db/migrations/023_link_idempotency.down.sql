DROP INDEX IF EXISTS links_merchant_idempotency_key_idx;
ALTER TABLE links DROP COLUMN IF EXISTS idempotency_key;
