import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

beforeAll(() => server.listen());
afterEach(() => { cleanup(); server.resetHandlers(); });
afterAll(() => server.close());

// jsdom doesn't scroll; the player scrolls to the top when moving between lessons.
window.scrollTo = () => {};
