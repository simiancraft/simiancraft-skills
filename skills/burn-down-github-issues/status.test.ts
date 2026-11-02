import { expect, it, spyOn } from 'bun:test';
import { configureStatus, lineState, mark, pulse, setLine } from './status.ts';

it('keeps finishing on the board and pulse after go', () => {
  const output = spyOn(console, 'log').mockImplementation(() => {});
  try {
    configureStatus({ silent: false });
    setLine('finishing', 'planned restart');
    setLine('active');
    setLine('paused');
    expect(lineState().state).toBe('finishing');
    mark(107, 'finish worker dispatch', 'B1');
    pulse();
    const lines = output.mock.calls.map((call) => String(call[0]));
    expect(lines.some((line) => line.includes('🎫 #107') && line.includes('finishing'))).toBe(true);
    expect(lines.some((line) => line.includes('💓 pulse') && line.includes('finishing'))).toBe(true);
    expect(lines.some((line) => line.includes('active'))).toBe(false);
  } finally {
    output.mockRestore();
  }
});
