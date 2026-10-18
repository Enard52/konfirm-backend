import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FacilitatorSpendLog } from './entities/facilitator-spend-log.entity';

export type SpendCategory = 'sweep' | 'fee-collection' | 'transfer';

@Injectable()
export class SpendGuardService {
  private readonly logger = new Logger(SpendGuardService.name);

  constructor(
    @InjectRepository(FacilitatorSpendLog)
    private readonly spendLogRepo: Repository<FacilitatorSpendLog>,
  ) {}

  /**
   * Check whether spending `amount` would exceed the daily cap, and if not,
   * record it. Returns the created log row so callers can reverse it if the
   * underlying transfer later fails.
   */
  async checkAndRecordSpend(
    amount: number,
    category: SpendCategory,
    destination: string,
  ): Promise<FacilitatorSpendLog> {
    const dailyCap = this.getDailyCap();
    const spentToday = await this.getSpentToday();

    if (spentToday + amount > dailyCap) {
      this.logger.error(
        `daily spend cap exceeded: spent=${spentToday} amount=${amount} cap=${dailyCap}`,
      );
      throw new Error(
        `Daily spend cap exceeded (spent ${spentToday} + ${amount} > cap ${dailyCap})`,
      );
    }

    const entry = this.spendLogRepo.create({
      amount,
      category,
      destination,
    });
    return this.spendLogRepo.save(entry);
  }

  /**
   * Reverse a previously recorded spend entry. Used when the transfer that the
   * spend was recorded for fails or times out, so failed attempts do not
   * consume real cap budget.
   */
  async reverseSpend(entry: FacilitatorSpendLog): Promise<void> {
    if (!entry || entry.id === undefined || entry.id === null) {
      return;
    }
    try {
      await this.spendLogRepo.delete(entry.id);
    } catch (err) {
      this.logger.error(
        `failed to reverse spend entry ${entry.id}: ${(err as Error).message}`,
      );
    }
  }

  private async getSpentToday(): Promise<number> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const result = await this.spendLogRepo
      .createQueryBuilder('log')
      .select('COALESCE(SUM(log.amount), 0)', 'total')
      .where('log.createdAt >= :startOfDay', { startOfDay })
      .getRawOne<{ total: string }>();

    return Number(result?.total ?? 0);
  }

  private getDailyCap(): number {
    const raw = process.env.FACILITATOR_DAILY_SPEND_CAP;
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1000;
  }
}
