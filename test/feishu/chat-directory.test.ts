import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { FeishuChatDirectory } from '../../src/feishu/chat-directory.js';

function sdk() {
  return { im: { v1: { chat: { list: vi.fn() } } } };
}

describe('FeishuChatDirectory', () => {
  it('resolves exactly one case-insensitive exact group across pages', async () => {
    const client = sdk();
    client.im.v1.chat.list
      .mockResolvedValueOnce({ data: { has_more: true, page_token: 'next', items: [
        { chat_id: 'oc_other', name: 'Product archive', chat_mode: 'group' },
      ] } })
      .mockResolvedValueOnce({ data: { items: [
        { chat_id: 'oc_product', name: 'PRODUCT', chat_mode: 'group' },
      ] } });

    await expect(new FeishuChatDirectory(client, pino({ level: 'silent' }))
      .resolveExactGroup(' Product ')).resolves.toEqual({
      status: 'resolved', chatId: 'oc_product', displayName: 'PRODUCT',
    });
    expect(client.im.v1.chat.list).toHaveBeenNthCalledWith(2, {
      params: { page_size: 100, page_token: 'next' },
    });
  });

  it('returns stable not-found and ambiguous results and ignores non-groups', async () => {
    const client = sdk();
    const directory = new FeishuChatDirectory(client, pino({ level: 'silent' }));
    client.im.v1.chat.list.mockResolvedValueOnce({ data: { items: [
      { chat_id: 'oc_partial', name: 'Product archive', chat_mode: 'group' },
      { chat_id: 'oc_p2p', name: 'Product', chat_mode: 'p2p' },
    ] } });
    await expect(directory.resolveExactGroup('Product')).resolves.toEqual({
      status: 'not_found', errorCategory: 'schedule_target_not_found',
    });

    client.im.v1.chat.list.mockResolvedValueOnce({ data: { items: [
      { chat_id: 'oc_a', name: 'Product', chat_mode: 'group' },
      { chat_id: 'oc_b', name: 'product', chat_mode: 'topic' },
    ] } });
    await expect(directory.resolveExactGroup('Product')).resolves.toEqual({
      status: 'ambiguous', errorCategory: 'schedule_target_ambiguous',
    });
  });

  it('contains provider failures and aborts without logging raw identifiers', async () => {
    const warnings: unknown[] = [];
    const logger = pino({ level: 'silent' });
    logger.warn = vi.fn((value: unknown) => warnings.push(value)) as typeof logger.warn;
    const client = sdk();
    client.im.v1.chat.list.mockRejectedValueOnce(new Error('Bearer secret oc_hidden'));
    const directory = new FeishuChatDirectory(client, logger);
    await expect(directory.resolveExactGroup('Secret group')).resolves.toEqual({
      status: 'unavailable', errorCategory: 'schedule_target_lookup_failed',
    });
    expect(JSON.stringify(warnings)).toBe('[{"errorCategory":"schedule_target_lookup_failed"}]');

    const controller = new AbortController();
    controller.abort();
    await expect(directory.resolveExactGroup('Product', controller.signal)).rejects.toThrow(
      'schedule_target_lookup_aborted',
    );
    expect(client.im.v1.chat.list).toHaveBeenCalledTimes(1);
  });
});
