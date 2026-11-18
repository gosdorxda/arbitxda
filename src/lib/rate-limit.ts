export function createRateLimiter(minIntervalMs: number) {
  let lastAt = 0;
  let queue: Promise<void> = Promise.resolve();

  return function schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = lastAt + minIntervalMs - Date.now();
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
      lastAt = Date.now();
      return fn();
    };

    const task = queue.then(run, run);
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
