export interface AdmissionCoordinator {
  wake(): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type AdmissionCoordinatorDependencies = {
  message: { processNext(): Promise<boolean> };
  scheduled: { processOne(now: Date): Promise<boolean> };
  concurrency: number;
  pollMs: number;
  now?: () => Date;
  onError?: (category: 'admission_iteration_failed') => void;
};

export function createAdmissionCoordinator(
  dependencies: AdmissionCoordinatorDependencies,
): AdmissionCoordinator {
  if (dependencies.concurrency < 1 || dependencies.pollMs < 1) {
    throw new Error('invalid_admission_options');
  }
  let stopping = true;
  let scheduledProcessing = false;
  let loops: Promise<void>[] = [];
  const wakeResolvers = new Set<() => void>();

  const wait = () => new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      wakeResolvers.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, dependencies.pollMs);
    wakeResolvers.add(finish);
  });

  const loop = async () => {
    while (!stopping) {
      try {
        // Message admission is always attempted first for every newly free slot.
        if (await dependencies.message.processNext()) continue;
        if (!scheduledProcessing) {
          scheduledProcessing = true;
          try {
            if (await dependencies.scheduled.processOne(dependencies.now?.() ?? new Date())) continue;
          } finally {
            scheduledProcessing = false;
          }
        }
      } catch {
        dependencies.onError?.('admission_iteration_failed');
      }
      await wait();
    }
  };

  return {
    wake() {
      for (const resolve of [...wakeResolvers]) resolve();
    },
    async start() {
      if (!stopping) return;
      stopping = false;
      loops = Array.from({ length: dependencies.concurrency }, loop);
    },
    async stop() {
      stopping = true;
      for (const resolve of [...wakeResolvers]) resolve();
      await Promise.all(loops);
      loops = [];
    },
  };
}
