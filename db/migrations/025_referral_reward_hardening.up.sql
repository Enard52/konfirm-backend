-- Tracks how many referral rewards a merchant has earned as referrer.
-- Used by the reward sweep to enforce MAX_REFERRAL_REWARDS_PER_REFERRER
-- without a COUNT(*) race: the sweep increments this atomically via
-- UPDATE ... RETURNING so the cap check and the increment are one
-- operation, not a read-then-write that two concurrent sweep processes
-- could both pass.
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS referrer_reward_count INT NOT NULL DEFAULT 0;
