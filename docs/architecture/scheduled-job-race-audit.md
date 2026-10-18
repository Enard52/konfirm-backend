# Scheduled Job Race Audit

Audit of every `@Cron`-decorated service in `src/`. Verdicts cover check-then-write races on shared state.

| Service | Verdict | Basis |
| --- | --- | --- |
| `ChannelKeeperService` | Safe | One advisory lock (`402_001`) serializes keeper runs across replicas. Claim writes use a compare-and-set on `pending_nonce`; keeper resync writes on-chain truth without deciding from a stale database value. |
| `FacilitatorSweepService` | Fixed | Its own sweep lock (`402_002`) does not serialize fee collection. Both callers now share the spend guard's transaction-scoped advisory lock (`402_005`) across halt check, cap check, and spend insert. |
| `FeeCollectionSweepService` | Fixed | Same shared spend guard serialization as the facilitator sweep; its per-job lock remains `402_003`. |
| `PaymentAttestationSweeperService` | Safe | Advisory lock (`402_004`) serializes the job across replicas, and the write only fills an unattested row (`attested_at IS NULL`). |
| `FeesSweeperService` | Fixed | Confirm/expire transitions now atomically change the pending settlement and its claimed payments, and only the winner of the pending-state update changes payments. |
| `ReferralRewardsService` | Safe | `UPDATE ... WHERE reward_granted_at IS NULL RETURNING` is the atomic claim, so overlapping runs cannot grant a referral twice. |
| `ReconcilerWatchdogService` | Safe | Read-only health check; it performs no shared-state write. |

The scheduled-job lock keys are distinct: channel keeper `402_001`, facilitator sweep `402_002`, fee-collection sweep `402_003`, and attestation sweep `402_004`. Spend accounting uses a transaction-scoped lock on `402_005`, shared by both facilitator sweep callers.

## Numeric Input Validation Audit

Numeric and ID-shaped controller inputs were compared with the downstream storage or protocol range.

| Input | Storage/domain range | Verdict |
| --- | --- | --- |
| Session `muxed_id` (POST and GET) | PostgreSQL signed `BIGINT` | Validated as a non-negative signed-64-bit decimal string. |
| Payment `muxed_id` query parameters | PostgreSQL signed `BIGINT` through the session/payment flow | Uses the same signed-64-bit validation. |
| Link `amount_usdc` | `NUMERIC(18,7)` | Validated to seven fractional digits and the column's maximum scaled value. |
| Testnet transfer `amount` | Stellar signed 64-bit stroops, seven decimal places | Validated against the maximum representable stroop amount. |
| x402 channel `channel_id` and `nonce` | PostgreSQL signed `BIGINT` | Validated to the stored range. |
| x402 `cumulative_amount` | Signed contract `i128`; database `NUMERIC` | Validated to the non-negative `i128` maximum. |

Other controller schemas in this pass use text, enums, booleans, UUIDs, or protocol-envelope numbers rather than numeric database amounts/IDs. The reconciler also uses checked `u64`-to-`i64` conversion before querying or writing session/payment rows.