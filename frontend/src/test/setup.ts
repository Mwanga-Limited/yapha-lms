import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

// jsdom doesn't scroll; the player scrolls to the top when moving between lessons.
window.scrollTo = () => {};
