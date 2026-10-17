# Fee Settlement and Reconciler Verdicts

## Merchant fee settlement

QR and mobile-wallet checkout can only express one payment operation, so the
checkout fee is recorded as owed rather than included in the payer's transaction.
The merchant later pays that fee from their own Stellar account. The merchant
signs the transaction; Konfirm builds and verifies it but never holds the
merchant's key. This is the implemented alternative to a facilitator-swept fee,
which would require Konfirm to control funds or introduce a sponsor-signing step
QR wallets cannot complete. See `docs/design/qr-fee-collection.md` for the tested
design trade-off.

The lifecycle is:

1. A confirmed payment without a checkout fee leg records `fee_status = 'owed'`
   and the exact fee amount and asset.
2. `POST /fees/settlements` builds an unsigned transaction for the owed balance.
   A merchant may request a smaller amount for one asset. The selected portion
   is recorded against its source payment rows as `claimed`; any unselected
   remainder remains owed.
3. `POST /fees/settlements/:id/dispute` is available before signing. It marks the
   settlement disputed and releases its claims; the owed amounts remain intact.
   The admin owed view flags the merchant, and `GET /admin/fees/disputed` lists
   disputed settlements for review.
4. The merchant signs the exact XDR and submits it to
   `POST /fees/settlements/:id/submit`. Konfirm verifies the transaction hash
   before Horizon submission. A confirmed settlement subtracts only its recorded
   allocations; any remainder returns to owed. Expired unsigned claims are also
   released. A submission error is retained and alerted while the transaction
   remains pending, since an ambiguous network response must not create a
   duplicate payment.

## Reconciler verdicts

`reconciler/src/verdict.rs`'s `assess()` compares a confirmed payment with the
link expectation captured for its session. A matching payment is `paid`; an
unmatched one is `held` with a reason so it is visible for review instead of
being counted as valid revenue.

| Reason | Operational meaning |
|---|---|
| `no_session` | The payment has no reserved checkout session to connect it to a link. |
| `link_inactive` | The session refers to a link that is no longer accepting payments. |
| `no_fixed_amount` | The expected amount is absent, so this payment cannot be verified against a fixed price. |
| `asset_mismatch` | The paid asset code differs from the link currency, or the currency is unknown. |
| `issuer_mismatch` | The asset code matches but its on-chain issuer is not the configured issuer; native XLM must have no issuer. |
| `amount_mismatch` | The paid amount differs from the fixed link amount in the asset's units. |

The missing checkout fee is not a verdict failure: the merchant receives the
link amount, while the fee is tracked separately as owed. The fee settlement
flow above handles that balance.