import { expect, test, vi } from 'vitest';
import { classify, plan, type Answers } from './jev';

const answers: Answers = {
  area: { choice: 'Tech', probabilities: { Tech: 0.8 } },
  libtype: { choice: 'Articles', probabilities: { Articles: 1 } },
  topic: { choice: 'none', probabilities: { none: 0.9, 'topic-ai': 0.5 } },
};
const state = { title: 'Title', url: 'https://example.com', description: 'd'.repeat(700), page_text_start: 't'.repeat(4000) };
test('request matches Jev contract, trims state and uses null topic criteria', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ answers }));
  expect(await classify('test-key', state, ['topic-ai'], { fetch: fetcher })).toEqual(answers);
  const [url, init] = fetcher.mock.calls[0]!;
  expect(url).toBe('https://api.openjev.sh/v1/systemone');
  expect(init?.method).toBe('POST');
  expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer test-key');
  expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json');
  const body = JSON.parse(String(init?.body));
  expect(body.model).toBe('openjev');
  expect(body.state).toEqual({ ...state, description: 'd'.repeat(600), page_text_start: 't'.repeat(3000) });
  expect(body.questions.topic.criteria).toEqual({ 'topic-ai': null, none: 'no listed topic fits' });
  expect(body.questions.area.criteria.Tech).toBe('software, AI, agents, developer tools, infrastructure, engineering');
  expect(init?.signal).toBeInstanceOf(AbortSignal);
});
test('plan uses area and resource choices, and highest non-none topic at the threshold', () => {
  expect(plan(answers)).toEqual({ lists: [['Research', 'Tech'], ['Library', 'Articles']], topic: 'topic-ai' });
  expect(plan({ ...answers, area: { choice: 'none', probabilities: {} }, libtype: { choice: 'none', probabilities: {} }, topic: { choice: 'none', probabilities: { none: 1, 'topic-ai': 0.49 } } })).toEqual({ lists: [], topic: null });
  expect(plan({ ...answers, topic: { choice: 'topic-ai', probabilities: { 'topic-ai': 0.5, 'topic-tools': 0.7 } } }).topic).toBe('topic-tools');
  expect(plan({ ...answers, topic: { choice: 'none', probabilities: { none: 1 } } }).topic).toBeNull();
});
test('malformed and unoffered answers are rejected', async () => {
  for (const value of [null, {}, { answers: {} }, { answers: { ...answers, area: null } },
    { answers: { ...answers, area: { choice: 'Other', probabilities: {} } } },
    { answers: { ...answers, topic: { choice: 'none', probabilities: { 'topic-unoffered': 1 } } } },
    { answers: { ...answers, topic: { choice: 'none', probabilities: { none: '1' } } } },
    { answers: { ...answers, topic: { choice: 'none', probabilities: { none: 1.1 } } } },
  ]) await expect(classify('test-key', state, ['topic-ai'], { fetch: async () => Response.json(value) })).rejects.toThrow('Invalid Jev response');
});
test('HTTP, JSON and network failures never expose secrets or response bodies', async () => {
  await expect(classify('secret', state, [], { fetch: async () => new Response('secret', { status: 401 }) })).rejects.toThrow('Jev request failed: 401');
  await expect(classify('secret', state, [], { fetch: async () => new Response('secret') })).rejects.toThrow('Invalid Jev response');
  await expect(classify('secret', state, [], { fetch: async () => { throw new Error('secret'); } })).rejects.toThrow('Jev request failed: network error');
});
