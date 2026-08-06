export type RetentionStore = {
  purgeExpired(before: Date): Promise<number>;
};

export type RetentionService = {
  start(): Promise<void>;
  stop(): void;
};

export type RetentionServiceOptions = {
  retentionMs: number;
  intervalMs?: number;
  now?: () => Date;
  onSuccess?: () => void;
  onError?: (details: { errorCode: 'retention_purge_failed' }) => void;
};

const ONE_DAY_MS = 24 * 60 * 60 * 1_000;

export function createRetentionService(
  store: RetentionStore,
  options: RetentionServiceOptions,
): RetentionService {
  const now = options.now ?? (() => new Date());
  const intervalMs = options.intervalMs ?? ONE_DAY_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let activeRun: Promise<void> | undefined;

  function runOnce(): Promise<void> {
    if (activeRun) return activeRun;
    const cutoff = new Date(now().getTime() - options.retentionMs);
    activeRun = store.purgeExpired(cutoff)
      .then(() => {
        options.onSuccess?.();
      })
      .catch((error: unknown) => {
        options.onError?.({ errorCode: 'retention_purge_failed' });
        throw error;
      })
      .finally(() => {
        activeRun = undefined;
      });
    return activeRun;
  }

  return {
    async start() {
      if (timer) return;
      timer = setInterval(() => {
        void runOnce().catch(() => undefined);
      }, intervalMs);
      timer.unref?.();
      await runOnce();
    },
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}
