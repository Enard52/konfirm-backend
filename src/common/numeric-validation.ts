import { z } from 'zod';

export const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;

export function nonNegativeIntegerStringSchema(maxValue: bigint, field: string) {
  return z
    .string()
    .regex(/^\d+$/, `${field} must be a non-negative integer string`)
    .refine((value) => BigInt(value) <= maxValue, `${field} exceeds its supported range`);
}

export function nonNegativeDecimalStringSchema(label: string, scale: number, maxScaledValue: bigint) {
  return z
    .string()
    .regex(new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`), `${label} must have at most ${scale} decimal places`)
    .refine((value) => {
      const [whole, fraction = ''] = value.split('.');
      const scaledValue = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0'));
      return scaledValue <= maxScaledValue;
    }, `${label} exceeds its supported range`);
}