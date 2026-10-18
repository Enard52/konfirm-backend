import { BadRequestException } from '@nestjs/common';
import { Asset } from '@stellar/stellar-sdk';
import { EURC_ISSUER, USDC_ISSUER } from './stellar-network';

export function resolveAsset(currency: string): Asset {
  if (currency === 'XLM') return Asset.native();
  if (currency === 'USDC') return new Asset('USDC', USDC_ISSUER);
  if (currency === 'EURC') return new Asset('EURC', EURC_ISSUER);
  throw new BadRequestException(`${currency} is not supported yet`);
}

/**
 * Returns true if the given balance list already contains a trustline for
 * `asset`. Only meaningful for non-native assets — callers should guard with
 * `asset.isNative()` before calling if they want to skip the check entirely
 * for XLM (which never needs a trustline).
 */
export function hasTrustline(
  balances: Array<{ asset_code?: string; asset_issuer?: string }>,
  asset: Asset,
): boolean {
  return balances.some(
    (b) => b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );
}
