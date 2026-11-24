import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSingleFlight, createKeyedQueue } from '../src/concurrency.ts';

test('shared work survives one caller cancelling and stops when all callers cancel', async () => {
  const run = createSingleFlight<string, string>();
  const first = new AbortController(),
    second = new AbortController();
  let calls = 0,
    sharedSignal: AbortSignal | undefined,
    finish!: (value: string) => void;
  const work = async (signal: AbortSignal) => {
    calls++;
    sharedSignal = signal;
    return new Promise<string>((resolve, reject) => {
      finish = resolve;
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const a = run('pin', first.signal, work);
  const b = run('pin', second.signal, work);
  await Promise.resolve();
  first.abort();
  await assert.rejects(a);
  assert.equal(sharedSignal!.aborted, false);
  finish('result');
  assert.equal(await b, 'result');
  assert.equal(calls, 1);

  const only = new AbortController();
  const abandoned = run('pin', only.signal, work);
  await Promise.resolve();
  only.abort();
  await assert.rejects(abandoned);
  assert.equal(sharedSignal!.aborted, true);
  assert.equal(await run('pin', undefined, async () => 'retry'), 'retry');
});

test('a cancelled queued caller cannot let later work overtake the active caller', async () => {
  const run = createKeyedQueue<string>();
  const trace: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const a = run('user', undefined, async () => {
    trace.push('a');
    await gate;
    trace.push('a done');
  });
  const controller = new AbortController();
  const b = run('user', controller.signal, async () => {
    trace.push('b');
  });
  const c = run('user', undefined, async () => {
    trace.push('c');
  });
  controller.abort();
  await assert.rejects(b);
  assert.deepEqual(trace, ['a']);
  release();
  await Promise.all([a, c]);
  assert.deepEqual(trace, ['a', 'a done', 'c']);
});
