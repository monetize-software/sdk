import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// globals:false means RTL can't auto-register its afterEach-cleanup — without
// this, every render() stays mounted for the rest of the file and queries can
// hit a previous test's tree (same-text matches land on the stale node).
afterEach(cleanup);
