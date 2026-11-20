import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FLOOR_PAUSE } from './floor/floor.ts';
import { HOST_PAUSE, pauseForHost } from './host-pause.ts';

let scratch: string;
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'host-pause-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const lines = (file: string) => readFileSync(file, 'utf8').split('\n');

describe('the host pause on the line switch', () => {
  it('pauses a line with no switch yet, and one that says go, naming the host fault', () => {
    const absent = join(scratch, 'runs-a', 'line-switch');
    expect(pauseForHost(absent, 'a host fault (ENOSPC) in E2 on #8')).toBe('paused');
    expect(lines(absent)[0]).toBe('pause');
    expect(lines(absent)[1]).toStartWith(`${HOST_PAUSE} a host fault (ENOSPC) in E2 on #8`);
    const go = join(scratch, 'go-switch');
    writeFileSync(go, 'go\n');
    expect(pauseForHost(go, 'a host fault (ENOMEM)')).toBe('paused');
    expect(lines(go)[1]).toContain('ENOMEM');
  });
  it('replaces a floor pause, which an incident fix could pass, and an earlier host pause', () => {
    const file = join(scratch, 'floor-switch');
    writeFileSync(file, `pause\n${FLOOR_PAUSE} item is absent; see the ledger on the floor\n`);
    expect(pauseForHost(file, 'a host fault (ENOSPC)')).toBe('paused');
    expect(lines(file)[1]).toStartWith(HOST_PAUSE);
    expect(pauseForHost(file, 'a host fault (ENOMEM)')).toBe('paused');
    expect(lines(file)[1]).toContain('ENOMEM');
  });
  it("leaves a person's pause and its reason alone", () => {
    const file = join(scratch, 'person-switch');
    writeFileSync(file, 'pause\nreleasing on Monday\n');
    expect(pauseForHost(file, 'a host fault (ENOSPC)')).toBe('kept');
    expect(readFileSync(file, 'utf8')).toBe('pause\nreleasing on Monday\n');
  });
});
