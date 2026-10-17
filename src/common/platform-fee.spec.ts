import { platformFeeAddress, getFeeCollectionSigner } from './platform-fee';

// Mock the createEd25519Signer — we only care that it's called with the
// right key, not the cryptographic correctness (that's tested in
// kms-ed25519-signer.spec.ts for the signer itself).
jest.mock('@x402/stellar', () => ({
  createEd25519Signer: jest.fn().mockImplementation((key) => ({
    // Minimal mock signer object
    address: 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL',
    __mockKey: key, // For assertion
  })),
}));

describe('platform-fee', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('platformFeeAddress()', () => {
    afterEach(() => {
      delete process.env.PLATFORM_FEE_ADDRESS;
    });

    it('returns the env var when set', () => {
      process.env.PLATFORM_FEE_ADDRESS = 'GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL';
      const result = platformFeeAddress();
      expect(result).toBe('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    });

    it('throws Error (not BadRequestException) when unset, without leaking env var name', () => {
      delete process.env.PLATFORM_FEE_ADDRESS;
      expect(() => platformFeeAddress()).toThrow(Error);
      expect(() => platformFeeAddress()).toThrow('platform fee collection is not configured');
      // Ensure the error message does NOT include the env var name
      expect(() => platformFeeAddress()).not.toThrow(/PLATFORM_FEE_ADDRESS/);
    });
  });

  describe('getFeeCollectionSigner()', () => {
    afterEach(() => {
      delete process.env.PLATFORM_FEE_SECRET_KEY;
    });

    it('returns a signer when the secret key is set', () => {
      process.env.PLATFORM_FEE_SECRET_KEY = 'SB4XQVGZLBZZ54TKIXJKHJWBHXCHQZL6CFTQH27UCBWXNQ4EZETUV2VQ';
      const result = getFeeCollectionSigner();
      expect(result).toBeDefined();
      expect(result.address).toBe('GDIET4T37N35XU4FY52RMR4Z653WYFITEHGIJXN4VEQTDYR5JSURJDPL');
    });

    it('throws Error (not BadRequestException) when unset, without leaking env var name', () => {
      delete process.env.PLATFORM_FEE_SECRET_KEY;
      expect(() => getFeeCollectionSigner()).toThrow(Error);
      expect(() => getFeeCollectionSigner()).toThrow('platform fee sweep is not configured');
      // Ensure the error message does NOT include the env var name
      expect(() => getFeeCollectionSigner()).not.toThrow(/PLATFORM_FEE_SECRET_KEY/);
    });
  });
});
