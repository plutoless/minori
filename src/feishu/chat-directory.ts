import type { Logger } from 'pino';

import type { FeishuSdk } from './client.js';

export type GroupResolution =
  | { status: 'resolved'; chatId: string; displayName: string }
  | { status: 'not_found'; errorCategory: 'schedule_target_not_found' }
  | { status: 'ambiguous'; errorCategory: 'schedule_target_ambiguous' }
  | { status: 'unavailable'; errorCategory: 'schedule_target_lookup_failed' };

export interface ChatDirectory {
  resolveExactGroup(name: string, signal?: AbortSignal): Promise<GroupResolution>;
}

async function waitForProvider<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error('schedule_target_lookup_aborted');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('schedule_target_lookup_aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export class FeishuChatDirectory implements ChatDirectory {
  constructor(private readonly client: FeishuSdk, private readonly logger: Logger) {}

  async resolveExactGroup(name: string, signal?: AbortSignal): Promise<GroupResolution> {
    const expected = name.trim().toLocaleLowerCase();
    if (!expected) return { status: 'not_found', errorCategory: 'schedule_target_not_found' };
    const matches = new Map<string, string>();
    let pageToken: string | undefined;
    try {
      do {
        if (signal?.aborted) throw new Error('schedule_target_lookup_aborted');
        const response = await waitForProvider(this.client.im.v1.chat.list({
          params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
        }), signal);
        if (response.code !== undefined && response.code !== 0) {
          throw new Error('schedule_target_lookup_failed');
        }
        for (const item of response.data?.items ?? []) {
          if (
            (item.chat_mode === 'group' || item.chat_mode === 'topic')
            && item.chat_id
            && item.name?.trim().toLocaleLowerCase() === expected
          ) {
            matches.set(item.chat_id, item.name);
          }
        }
        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    } catch (error) {
      if (error instanceof Error && error.message === 'schedule_target_lookup_aborted') throw error;
      this.logger.warn(
        { errorCategory: 'schedule_target_lookup_failed' },
        'schedule target lookup failed',
      );
      return { status: 'unavailable', errorCategory: 'schedule_target_lookup_failed' };
    }
    if (matches.size === 0) {
      return { status: 'not_found', errorCategory: 'schedule_target_not_found' };
    }
    if (matches.size > 1) {
      return { status: 'ambiguous', errorCategory: 'schedule_target_ambiguous' };
    }
    const [chatId, displayName] = matches.entries().next().value as [string, string];
    return { status: 'resolved', chatId, displayName };
  }
}
