/**
 * Task 21 — AgentChat send flow.
 *
 * Mocks global `fetch` so we don't need the API route live. Verifies that
 * typing into the input and pressing Send posts the running message list to
 * /api/agent/chat and appends the plain-text response to the rendered log.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AgentChat } from '@/components/AgentChat';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('AgentChat', () => {
  test('sending text posts to /api/agent/chat and appends the response', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Tampa TIV is $42M', { status: 200 }));

    render(<AgentChat />);
    const input = screen.getByLabelText('agent-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Tampa exposure?' } });
    fireEvent.click(screen.getByText('Send'));

    await waitFor(() => {
      expect(screen.getByText(/Tampa TIV is \$42M/)).toBeInTheDocument();
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('/api/agent/chat');
    expect((init as RequestInit).method).toBe('POST');
    const payload = JSON.parse(String((init as RequestInit).body));
    expect(payload.messages).toEqual([{ role: 'user', content: 'Tampa exposure?' }]);

    // User echo also rendered.
    expect(screen.getByText(/Tampa exposure\?/)).toBeInTheDocument();
  });

  test('renders an error line when fetch rejects', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
    render(<AgentChat />);
    const input = screen.getByLabelText('agent-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => {
      expect(screen.getByText(/Error: network down/)).toBeInTheDocument();
    });
  });
});
