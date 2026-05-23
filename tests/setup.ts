import * as matchers from '@testing-library/jest-dom/matchers';
import { expect, vi } from 'vitest';

expect.extend(matchers);

// Stub `next/navigation` for jsdom renders. Without it any component that
// calls `useRouter()` / `usePathname()` / `useSearchParams()` throws
// `invariant expected app router to be mounted` because the Next App
// Router context only exists at runtime. The stubs return inert no-ops so
// the assertion remains on component behaviour, not router wiring — any
// test that wants to assert refresh-call semantics can still
// `vi.mocked(...)` over these.
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  redirect: vi.fn(),
}));
