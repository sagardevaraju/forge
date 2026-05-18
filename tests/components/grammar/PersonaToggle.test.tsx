import { describe, test, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PersonaToggle } from '@/components/grammar/PersonaToggle';

afterEach(cleanup);

describe('PersonaToggle', () => {
  test('renders all five persona buttons', () => {
    render(<PersonaToggle value="cat-ops" onChange={() => {}} />);
    for (const p of ['Cat-ops', 'Actuary', 'Reinsurance', 'Field-ops', 'Academic']) {
      expect(screen.getByRole('button', { name: p })).toBeInTheDocument();
    }
  });
  test('marks the active persona', () => {
    render(<PersonaToggle value="actuary" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Actuary' })).toHaveAttribute('aria-pressed', 'true');
  });
  test('invokes onChange when a button is clicked', () => {
    let received = '';
    render(<PersonaToggle value="cat-ops" onChange={(v) => { received = v; }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actuary' }));
    expect(received).toBe('actuary');
  });
});
