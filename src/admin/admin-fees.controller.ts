import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../admin-auth/admin-auth.guard';
import { pool } from '../db/pool';

// Who owes what. Read-only: settlement is the merchant's signature, and a
// merchant in arrears is handled through the existing suspend action.
@Controller('admin/fees')
@UseGuards(AdminGuard)
export class AdminFeesController {
  @Get('owed')
  async owed() {
    const { rows } = await pool.query(
      `SELECT m.id AS merchant_id, m.name, m.email, m.status,
              p.fee_asset_code AS asset_code, p.fee_asset_issuer AS asset_issuer,
              SUM(p.fee_owed_raw)::text AS amount, COUNT(*)::int AS payments,
              MIN(p.created_at) AS oldest_owed_at,
              EXISTS (SELECT 1 FROM fee_settlements fs WHERE fs.merchant_id = m.id AND fs.status = 'disputed') AS has_disputed_settlement,
              (SELECT COUNT(*)::int FROM fee_settlements fs WHERE fs.merchant_id = m.id AND fs.status = 'disputed') AS disputed_settlement_count
       FROM payments p JOIN merchants m ON m.id = p.merchant_id
       WHERE p.fee_status = 'owed' AND p.status = 'paid'
       GROUP BY m.id, m.name, m.email, m.status, p.fee_asset_code, p.fee_asset_issuer
       ORDER BY oldest_owed_at ASC`,
    );
    return rows;
  }

  @Get('disputed')
  async disputed() {
    const { rows } = await pool.query(
      `SELECT fs.id AS settlement_id, fs.merchant_id, m.name, m.email,
              fs.tx_hash, fs.created_at, fs.unsigned_xdr,
              COALESCE(json_agg(json_build_object(
                'asset_code', p.fee_asset_code,
                'asset_issuer', p.fee_asset_issuer,
                'amount', i.amount::text
              )) FILTER (WHERE i.payment_id IS NOT NULL), '[]'::json) AS totals
       FROM fee_settlements fs
       JOIN merchants m ON m.id = fs.merchant_id
       LEFT JOIN fee_settlement_items i ON i.settlement_id = fs.id
       LEFT JOIN payments p ON p.id = i.payment_id
       WHERE fs.status = 'disputed'
       GROUP BY fs.id, fs.merchant_id, m.name, m.email
       ORDER BY fs.created_at DESC`,
    );
    return rows;
  }
}
