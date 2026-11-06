// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { describeSpec, nextRun, parseSpec, SpecError } from '../src/session/schedule.ts';

const TZ = 'Asia/Shanghai';
// 2026-11-06 (Friday) 10:00 Shanghai time = 02:00 UTC
const FRI_10 = Date.UTC(2026, 10, 6, 2, 0);

describe('定时任务规则', () => {
  it('解析', () => {
    expect(parseSpec('每天 09:30 总结新闻')).toEqual({ spec: { kind: 'daily', hh: 9, mm: 30 }, rest: '总结新闻' });
    expect(parseSpec('工作日 9：05 早报').spec).toEqual({ kind: 'weekdays', hh: 9, mm: 5 });
    expect(parseSpec('每周一 08:00 周报').spec).toEqual({ kind: 'weekly', dow: 1, hh: 8, mm: 0 });
    expect(parseSpec('每 2 小时 看一下').spec).toEqual({ kind: 'interval', minutes: 120 });
    expect(() => parseSpec('每 5 分钟 x')).toThrow(SpecError);
    expect(() => parseSpec('每天 25:00 x')).toThrow(SpecError);
    expect(() => parseSpec('明天 9 点')).toThrow(SpecError);
    expect(describeSpec({ kind: 'weekly', dow: 0, hh: 7, mm: 5 })).toBe('每周日 07:05');
  });

  it('解析英文关键字', () => {
    expect(parseSpec('daily 09:30 summarize the news')).toEqual({ spec: { kind: 'daily', hh: 9, mm: 30 }, rest: 'summarize the news' });
    expect(parseSpec('Weekdays 9:05 morning brief').spec).toEqual({ kind: 'weekdays', hh: 9, mm: 5 });
    expect(parseSpec('every Monday 08:00 weekly report').spec).toEqual({ kind: 'weekly', dow: 1, hh: 8, mm: 0 });
    expect(parseSpec('every sun 07:05 x').spec).toEqual({ kind: 'weekly', dow: 0, hh: 7, mm: 5 });
    expect(parseSpec('every 2 hours check').spec).toEqual({ kind: 'interval', minutes: 120 });
    expect(parseSpec('every 30 minutes check').spec).toEqual({ kind: 'interval', minutes: 30 });
    expect(() => parseSpec('every 5 minutes x')).toThrow(SpecError);
    expect(() => parseSpec('daily 24:00 x')).toThrow(SpecError);
  });

  it('下次执行时间（按时区）', () => {
    expect(nextRun({ kind: 'daily', hh: 9, mm: 0 }, FRI_10, TZ)).toBe(Date.UTC(2026, 10, 7, 1, 0)); // Saturday 09:00
    expect(nextRun({ kind: 'daily', hh: 11, mm: 0 }, FRI_10, TZ)).toBe(Date.UTC(2026, 10, 6, 3, 0)); // Today 11:00
    expect(nextRun({ kind: 'weekdays', hh: 9, mm: 0 }, FRI_10, TZ)).toBe(Date.UTC(2026, 10, 9, 1, 0)); // Next Monday
    expect(nextRun({ kind: 'weekly', dow: 5, hh: 10, mm: 0 }, FRI_10, TZ)).toBe(Date.UTC(2026, 10, 13, 2, 0)); // Next Friday (strictly later)
    expect(nextRun({ kind: 'interval', minutes: 30 }, FRI_10, TZ)).toBe(FRI_10 + 30 * 60_000);
    expect(nextRun({ kind: 'daily', hh: 9, mm: 0 }, FRI_10, 'UTC')).toBe(Date.UTC(2026, 10, 6, 9, 0));
  });
});
