import { describe, test, expect, vi } from 'vitest';
import { CascadingLLM } from '@/lib/llm/cascading-client';

describe('CascadingLLM', () => {
  test('falls over to secondary when primary returns 503', async () => {
    const primary = vi.fn().mockRejectedValue({ status: 503 });
    const fallback = vi.fn().mockResolvedValue({ content: 'ok' });
    const llm = new CascadingLLM({ primary, fallback, maxRetries: 1, baseDelayMs: 0 });
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('ok');
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('retries primary on 429 with backoff before failing over', async () => {
    const primary = vi
      .fn()
      .mockRejectedValueOnce({ status: 429 })
      .mockRejectedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ content: 'recovered' });
    const fallback = vi.fn();
    const llm = new CascadingLLM({ primary, fallback, maxRetries: 3, baseDelayMs: 0 });
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('recovered');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('throws immediately on non-retry status (400) without trying fallback', async () => {
    const primary = vi.fn().mockRejectedValue({ status: 400 });
    const fallback = vi.fn();
    const llm = new CascadingLLM({ primary, fallback, maxRetries: 3, baseDelayMs: 0 });
    await expect(llm.chat({ messages: [{ role: 'user', content: 'hi' }] })).rejects.toMatchObject({
      status: 400,
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('returns content with tool_calls when provider includes them', async () => {
    const toolCall = { id: 'c1', name: 'lookup', arguments: { x: 1 } };
    const primary = vi.fn().mockResolvedValue({
      content: 'using tool',
      tool_calls: [toolCall],
    });
    const fallback = vi.fn();
    const llm = new CascadingLLM({ primary, fallback, maxRetries: 1, baseDelayMs: 0 });
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('using tool');
    expect(result.tool_calls).toEqual([toolCall]);
    expect(fallback).not.toHaveBeenCalled();
  });

  test('falls back when primary exhausts all retries on 503', async () => {
    const primary = vi
      .fn()
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 })
      .mockRejectedValueOnce({ status: 503 });
    const fallback = vi.fn().mockResolvedValue({ content: 'fallback ok' });
    const llm = new CascadingLLM({ primary, fallback, maxRetries: 3, baseDelayMs: 0 });
    const result = await llm.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.content).toBe('fallback ok');
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});
