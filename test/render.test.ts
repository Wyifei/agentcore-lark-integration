// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { describe, expect, it } from 'vitest';
import { prepareCardMarkdown, MAX_TABLES } from '../src/render/markdown.ts';
import { applyEvent, newTurnState } from '../src/render/turn-state.ts';
import {
  buildFinalCardFitted,
  buildStreamingCard,
  byteLen,
  CARD_MAX_BYTES,
  fmtTokens,
  truncateBytes,
  STREAM_ANSWER_MAX_BYTES,
  streamingAnswer,
} from '../src/render/cards.ts';
import { CardStream } from '../src/render/card-stream.ts';
import { FakeLark } from './fakes.ts';

describe('markdown', () => {
  it('补全未闭合代码块', () => {
    expect(prepareCardMarkdown('a\n```js\nx')).toBe('a\n```js\nx\n```');
    expect(prepareCardMarkdown('```\nx\n```\nb')).toBe('```\nx\n```\nb');
  });
  it('外链图片改链接、中和 <at>，代码里不动', () => {
    expect(prepareCardMarkdown('![p](https://x/y.png) <at id=all></at> `<at>`')).toBe('[p](https://x/y.png) &lt;at id=all>&lt;/at> `<at>`');
  });
  it('表格超过上限转代码块', () => {
    const t = '| a | b |\n|---|---|\n| 1 | 2 |\n\n';
    const out = prepareCardMarkdown(t.repeat(MAX_TABLES + 1));
    expect(out.match(/```/g)).toHaveLength(2);
  });
});

describe('cards', () => {
  it('fmtTokens', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1234)).toBe('1.2k');
    expect(fmtTokens(12345)).toBe('12k');
  });
  it('truncateBytes 不切断多字节', () => {
    expect(truncateBytes('你好世界', 7)).toBe('你好');
  });
  it('流式卡片只含 markdown 元素', () => {
    const c = buildStreamingCard(newTurnState()) as { body: { elements: { tag: string }[] } };
    expect(c.body.elements.every((e) => e.tag === 'markdown')).toBe(true);
  });
  it('流式正文超预算截断', () => {
    const st = newTurnState();
    st.answer = '中'.repeat(20_000);
    expect(byteLen(streamingAnswer(st))).toBeLessThan(STREAM_ANSWER_MAX_BYTES + 200);
  });
  it('最终卡片超长时截断并标记', () => {
    const st = newTurnState();
    st.phase = 'done';
    st.answer = '中文'.repeat(20_000);
    const { card, truncated } = buildFinalCardFitted(st);
    expect(truncated).toBe(true);
    expect(byteLen(JSON.stringify(card))).toBeLessThanOrEqual(CARD_MAX_BYTES);
    expect(JSON.stringify(card)).toContain('完整回复见下方文件');
    const small = newTurnState();
    small.phase = 'done';
    small.answer = 'hi';
    expect(buildFinalCardFitted(small).truncated).toBe(false);
  });
  it('最终卡片：思考面板、按钮、错误提示', () => {
    const st = newTurnState();
    applyEvent(st, { type: 'reasoning', delta: 'hmm' });
    applyEvent(st, { type: 'tool_start', id: 't', name: 'search', input: { q: 'abc' } });
    applyEvent(st, { type: 'tool_end', id: 't', status: 'success', summary: '5 条' });
    st.phase = 'error';
    st.errorCode = 'FORBIDDEN_403';
    st.retryValue = { a: 'retry' };
    st.traceUrl = 'https://x';
    const s = JSON.stringify(buildFinalCardFitted(st).card);
    expect(s).toContain('collapsible_panel');
    expect(s).toContain('search');
    expect(s).toContain('FORBIDDEN_403');
    expect(s).toContain('重新生成');
    expect(s).toContain('查看 Trace');
  });
});

describe('CardStream', () => {
  it('写队列合并中间版本，序号递增，结束换最终卡片', async () => {
    const api = new FakeLark();
    api.writeDelayMs = 20;
    const st = newTurnState();
    const cs = new CardStream(api, { kind: 'chat', chatId: 'oc' }, st, { minIntervalMs: 0 });
    await cs.open();
    for (let i = 0; i < 50; i++) {
      applyEvent(st, { type: 'text', delta: `${i} ` });
      cs.changed();
      await new Promise((r) => setTimeout(r, 1));
    }
    st.phase = 'done';
    await cs.finish();
    const writes = api.ops('elementContent');
    expect(writes.length).toBeLessThan(50); // Intermediate versions are dropped
    const seqs = [...writes, ...api.ops('cardUpdate')].map((c) => c.args.at(-1) as number);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    const final = api.ops('cardUpdate').at(-1)!;
    expect(JSON.stringify(final.args[1])).toContain('49');
    expect(JSON.stringify(final.args[1])).toContain('"streaming_mode":false');
  });

  it('连续失败后停止流式写入，结束时仍写最终卡片；排队卡片原地替换', async () => {
    const api = new FakeLark();
    api.failElement = 100;
    const st = newTurnState();
    const cs = new CardStream(api, { kind: 'chat', chatId: 'oc' }, st, { minIntervalMs: 0 });
    await cs.open('om_queued');
    expect(api.ops('sendCard')).toHaveLength(0);
    expect(api.ops('idConvert')[0]!.args[0]).toBe('om_queued');
    for (let i = 0; i < 10; i++) {
      applyEvent(st, { type: 'text', delta: 'x' });
      cs.changed();
      await new Promise((r) => setTimeout(r, 1));
    }
    st.phase = 'done';
    await cs.finish();
    expect(api.failElement).toBeGreaterThan(90);
    expect(api.ops('cardUpdate')).toHaveLength(2);
  });

  it('超长回复另发文件', async () => {
    const api = new FakeLark();
    const st = newTurnState();
    const cs = new CardStream(api, { kind: 'chat', chatId: 'oc' }, st);
    await cs.open();
    st.answer = 'x'.repeat(40_000);
    st.phase = 'done';
    expect((await cs.finish()).truncated).toBe(true);
    expect(api.ops('sendFile')).toHaveLength(1);
  });
});
