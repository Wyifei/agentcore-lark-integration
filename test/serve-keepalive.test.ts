// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Regression: with no bots, the serve process once exited immediately with 0 because all timers were unref'd
describe('serve keepalive', () => {
  it('serve() 里有一个不 unref 的定时器', () => {
    const src = readFileSync(new URL('../src/app/service.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('export async function serve'));
    expect(body).toMatch(/const keepalive = setInterval\(/);
    expect(body).not.toMatch(/keepalive\.unref/);
  });
});
