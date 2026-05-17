import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import Landing from '@/app/page';

afterEach(cleanup);

describe('Landing', () => {
  test('renders four exec cards', async () => {
    const ui = await Landing();
    render(ui);
    expect(screen.getAllByTestId('exec-card').length).toBe(4);
  });
});
