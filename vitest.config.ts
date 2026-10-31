import { defineConfig } from 'vitest/config';

// The PDF and ID photo tests take about 0.5 s, but over 5 s on a busy PC. A timed-out test keeps running and its
// cleanup removes the fake fetch from the next test, so one slow test can also fail another.
export default defineConfig({
  test: { testTimeout: 60_000 },
});
