import { describe, expect, it } from 'bun:test';
import type { Context } from './context.ts';
import { serializePullMaster } from './pipeline.ts';

const issue = (number: number) => ({ number, title: `issue ${number}`, createdAt: '2026-09-01T00:00:00Z', labels: [] });

function line() {
  const cards: Array<{ issue: number; lane: string; note?: string }> = [];
  const ctx = { project: { repo: 'o/r' }, integrationQueue: Promise.resolve(), log: () => {}, onLane: (e: { issue: number; lane: string; note?: string }) => cards.push({ issue: e.issue, lane: e.lane, note: e.note }) } as unknown as Context;
  return { ctx, cards };
}

describe('the landing line', () => {
  it('lets a lane behind a landing say whom it waits behind, once, on the console and on its card', async () => {
    const { ctx, cards } = line();
    const said: string[] = [];
    let release = () => {};
    const first = serializePullMaster(ctx, issue(1), (m) => said.push(`1: ${m}`), () => new Promise<string>((resolve) => (release = () => resolve('landed'))));
    await Promise.resolve();
    const order: number[] = [];
    const second = serializePullMaster(ctx, issue(2), (m) => said.push(`2: ${m}`), async () => order.push(2));
    expect(said).toEqual(['2: waiting for the landing line behind #1']);
    expect(cards).toEqual([{ issue: 2, lane: 'F1', note: 'waiting for the landing line behind #1' }]);
    expect(order).toEqual([]);
    release();
    expect(await first).toBe('landed');
    await second;
    expect(order).toEqual([2]);
    expect(ctx.landingHolder).toBeNull();
  });

  it('says nothing when the line is free, and frees the line when a landing throws', async () => {
    const { ctx, cards } = line();
    const said: string[] = [];
    await expect(serializePullMaster(ctx, issue(1), (m) => said.push(m), async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(ctx.landingHolder).toBeNull();
    await serializePullMaster(ctx, issue(2), (m) => said.push(m), async () => 'ok');
    expect(said).toEqual([]);
    expect(cards).toEqual([]);
  });
});
