/**
 * Task P2.25 — AgentChat procedure-mode UI.
 *
 * Verifies that:
 *   * The Free/Procedure toggle is rendered.
 *   * Selecting Procedure swaps the freeform input for a runbook picker.
 *   * Picking a runbook reveals the storm_id field.
 *   * Submitting fires POST /api/agent/chat with mode='procedure',
 *     runbook_id, and runbook_params.{storm_id}.
 *   * Tool_call events with a `description` are surfaced verbatim on the
 *     status line so operators see "Calling X — <description>… (Step N)".
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

describe('AgentChat procedure mode', () => {
  test('mode toggle is rendered with Free + Procedure options', () => {
    render(<AgentChat />);
    expect(screen.getByTestId('agent-mode-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('agent-mode-free')).toBeInTheDocument();
    expect(screen.getByTestId('agent-mode-procedure')).toBeInTheDocument();
  });

  test('switching to Procedure reveals the runbook picker', () => {
    render(<AgentChat />);
    // Free is default — freeform input is visible.
    expect(screen.getByLabelText('agent-input')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('agent-mode-procedure'));
    // Freeform input gone, picker visible.
    expect(screen.queryByLabelText('agent-input')).toBeNull();
    expect(screen.getByLabelText('agent-runbook')).toBeInTheDocument();
    // Run button replaces Send.
    expect(screen.getByRole('button', { name: /run/i })).toBeInTheDocument();
  });

  test('picking a runbook reveals the storm_id field', () => {
    render(<AgentChat />);
    fireEvent.click(screen.getByTestId('agent-mode-procedure'));
    expect(screen.queryByLabelText('agent-storm-id')).toBeNull();
    fireEvent.change(screen.getByLabelText('agent-runbook'), {
      target: { value: 'pre_landfall_t72' },
    });
    expect(screen.getByLabelText('agent-storm-id')).toBeInTheDocument();
  });

  test('submitting a runbook POSTs mode=procedure + runbook_id + params', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('runbook complete', { status: 200 }));

    render(<AgentChat />);
    fireEvent.click(screen.getByTestId('agent-mode-procedure'));
    fireEvent.change(screen.getByLabelText('agent-runbook'), {
      target: { value: 'pre_landfall_t72' },
    });
    fireEvent.change(screen.getByLabelText('agent-storm-id'), {
      target: { value: 'AL092024' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe('/api/agent/chat');
    expect((init as RequestInit).method).toBe('POST');
    const payload = JSON.parse(String((init as RequestInit).body));
    expect(payload.mode).toBe('procedure');
    expect(payload.runbook_id).toBe('pre_landfall_t72');
    expect(payload.runbook_params).toEqual({ storm_id: 'AL092024' });
    // The user echo carries the runbook id so the chat log is readable.
    expect(payload.messages[0].content).toMatch(/pre_landfall_t72/);
    expect(payload.messages[0].content).toMatch(/AL092024/);
  });

  test('renders tool_call description verbatim in the status line', async () => {
    let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controllerRef = c;
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(stream, { status: 200 }),
    );

    render(<AgentChat />);
    fireEvent.click(screen.getByTestId('agent-mode-procedure'));
    fireEvent.change(screen.getByLabelText('agent-runbook'), {
      target: { value: 'pre_landfall_t72' },
    });
    fireEvent.change(screen.getByLabelText('agent-storm-id'), {
      target: { value: 'AL092024' },
    });
    fireEvent.click(screen.getByRole('button', { name: /run/i }));

    const enc = new TextEncoder();
    const ev = {
      type: 'tool_call',
      name: 'fetch_nhc_cone',
      arguments: { storm_id: 'AL092024' },
      iteration: 1,
      description: 'Fetch the latest NHC forecast cone',
    };
    await waitFor(() => expect(controllerRef).not.toBeNull());
    controllerRef!.enqueue(enc.encode(JSON.stringify(ev) + '\n'));

    const statusLine = await screen.findByTestId('agent-status-line');
    await waitFor(() =>
      expect(statusLine.textContent).toMatch(/Fetch the latest NHC forecast cone/),
    );
    await waitFor(() => expect(statusLine.textContent).toMatch(/Step 1/));

    controllerRef!.close();
  });

  test('Free mode still works after the toggle is rendered (regression)', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('Tampa TIV is $42M', { status: 200 }));

    render(<AgentChat />);
    fireEvent.change(screen.getByLabelText('agent-input'), {
      target: { value: 'Tampa exposure?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /send/i }));

    await waitFor(() =>
      expect(screen.getByText(/Tampa TIV is \$42M/)).toBeInTheDocument(),
    );
    const [, init] = fetchSpy.mock.calls[0];
    const payload = JSON.parse(String((init as RequestInit).body));
    // Free mode payload does NOT include mode / runbook_id keys.
    expect(payload.mode).toBeUndefined();
    expect(payload.runbook_id).toBeUndefined();
  });
});
