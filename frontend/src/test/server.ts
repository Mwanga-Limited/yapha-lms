import { setupServer } from 'msw/node';

/** Requests are answered per test with server.use(...); anything unexpected fails the test. */
export const server = setupServer();
