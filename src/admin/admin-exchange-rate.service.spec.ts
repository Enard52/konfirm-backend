import { AdminExchangeRateService } from './admin-exchange-rate.service';

describe('AdminExchangeRateService', () => {
  let service: AdminExchangeRateService;
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    service = new AdminExchangeRateService();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('passes a timeout AbortSignal to Horizon fetch and returns calculated rate', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        bids: [{ price: '0.1200000' }],
        asks: [{ price: '0.1220000' }],
      }),
    } as Response);

    const result = await service.liveXlmUsdcRate();
    expect(result).toEqual({ rate: '0.1210000', reachable: true });
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('order_book'),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('handles request timeout/abort by catching error and returning reachable: false', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    fetchMock.mockRejectedValueOnce(timeoutError);

    const result = await service.liveXlmUsdcRate();
    expect(result).toEqual({ rate: null, reachable: false });
  });

  it('returns reachable: false when Horizon returns non-200 HTTP status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 504,
    } as Response);

    const result = await service.liveXlmUsdcRate();
    expect(result).toEqual({ rate: null, reachable: false });
  });
});
