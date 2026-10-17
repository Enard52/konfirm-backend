export function concurrentCalls<T>(count: number, call: (index: number) => Promise<T>): Promise<PromiseSettledResult<T>[]> {
  return Promise.allSettled(Array.from({ length: count }, (_, index) => call(index)));
}