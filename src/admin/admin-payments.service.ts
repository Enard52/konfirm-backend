import { Injectable, NotFoundException } from '@nestjs/common';
import { pool } from '../db/pool';

@Injectable()
export class AdminPaymentsService {
  async list(status?: string, limit = 50, offset = 0) {
    const params: unknown[] = [];
    let where = '';
    if (status) {
      params.push(status);
      where = `WHERE p.status = $${params.length}`;
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT p.id, p.amount_usdc, p.asset_code, p.payer_address, p.status, p.flag_reason, p.tx_hash, p.created_at,
              m.name AS merchant_name, m.email AS merchant_email
       FROM payments p
       JOIN merchants m ON m.id = p.merchant_id
       ${where}
       ORDER BY p.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return rows;
  }

  async setStatus(id: string, status: 'paid' | 'held' | 'disputed') {
    // Same pre-update-snapshot pattern as AdminMerchantsService.setTier.
    const { rows } = await pool.query(
      `UPDATE payments p SET status = $2
       FROM (SELECT id, status FROM payments WHERE id = $1 FOR UPDATE) old
       WHERE p.id = old.id
       RETURNING p.id, p.status, old.status AS previous_status`,
      [id, status],
    );
    if (rows.length === 0) throw new NotFoundException('payment not found');
    const { previous_status: previous, ...payment } = rows[0];
    return { payment, previous: previous as string };
  }
}
