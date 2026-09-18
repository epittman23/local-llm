import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// @testing-library/react normally registers this itself, but only when it
// finds a *global* afterEach -- this project doesn't set vitest's
// `test.globals: true` (tests import afterEach/describe/it from 'vitest'
// explicitly instead), so that auto-registration silently never fires.
// Without it, a component rendered in one test stays mounted for the next
// one in the same file: found via a real bug it caused, not read about --
// two tests sharing a Zustand store (useAuthGate.test.tsx) each rendered
// their own component, and a state change in the second test's setup made
// BOTH the leftover first instance and the new one fire the same effect,
// so a "called once" assertion saw two identical calls.
afterEach(() => {
	cleanup();
});
