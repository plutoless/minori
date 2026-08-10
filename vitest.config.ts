import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: ['test/**/*.test.ts'],
    exclude: [
      'test/contract/**/*.test.ts',
      'test/storage/allowed-chat-store.test.ts',
      'test/storage/conversation-store.test.ts',
      'test/storage/event-store.test.ts',
      'test/storage/storage-runtime.test.ts',
    ],
  },
});
