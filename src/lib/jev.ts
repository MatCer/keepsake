import { isRecord } from './capture-validation';
import { originPattern, type ClientOptions } from './karakeep';

/** Any service speaking the Jev systemone protocol: openjev, the official Jev API, OpenRouter, self-hosted. */
export interface JevConfig { endpoint: string; model: string; apiKey: string }
/** Throws on an endpoint that is not HTTPS (or local HTTP). */
export function jevPermissions(endpoint: string) {
  const origins = [originPattern(endpoint)];
  // Firefox also gates sending page content on the optional `websiteContent` data-collection consent.
  return import.meta.env.FIREFOX ? { origins, data_collection: ['websiteContent'] } : { origins };
}
export type JevOptions = Pick<ClientOptions, 'fetch' | 'timeoutMs'>;
export interface JevState { title: string; url: string; description: string | null; page_text_start: string }
interface Answer<T extends string> { choice: T; probabilities: Record<string, number> }
const areas = {
  Tech: 'software, AI, agents, developer tools, infrastructure, engineering',
  Business: 'business models, marketing, sales, startups, making money, distribution',
  Ideas: 'a concrete product or business idea to build', none: 'not research material (entertainment, personal)',
};
const libtypes = {
  Videos: 'a video', Repos: 'a source code repository', Tools: 'a product, service, app or website you can use',
  Articles: 'a blog post, documentation page, paper or news article', none: 'none of these',
};
export interface Answers {
  area: Answer<keyof typeof areas>;
  libtype: Answer<keyof typeof libtypes>;
  topic: Answer<string>;
}
function invalid(): never { throw new Error('Invalid Jev response'); }
function answer<T extends string>(value: unknown, choices: T[]): Answer<T> {
  if (!isRecord(value) || !isRecord(value.probabilities)) return invalid();
  const choice = choices.find(c => c === value.choice);
  if (choice === undefined) return invalid();
  const probabilities: Record<string, number> = {};
  for (const [name, probability] of Object.entries(value.probabilities)) {
    if (!choices.some(c => c === name) || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) return invalid();
    probabilities[name] = probability;
  }
  if (!(choice in probabilities)) return invalid();
  return { choice, probabilities };
}
export async function classify(config: JevConfig, state: JevState, topics: string[], opts: JevOptions = {}): Promise<Answers> {
  const questions = {
    area: { type: 'choice', instructions: 'Which research area does this bookmark belong to?', criteria: areas },
    libtype: { type: 'choice', instructions: 'What kind of resource is this bookmark?', criteria: libtypes },
    topic: { type: 'choice', instructions: 'Which existing topic tag fits this bookmark best?', criteria: { ...Object.fromEntries(topics.map(t => [t, null])), none: 'no listed topic fits' } },
  };
  jevPermissions(config.endpoint);
  let response: Response;
  try {
    response = await (opts.fetch ?? globalThis.fetch)(config.endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, state: { ...state, description: (state.description ?? '').slice(0, 600), page_text_start: state.page_text_start.slice(0, 3000) }, questions }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000), redirect: 'error',
    });
  } catch { throw new Error('Jev request failed: network error'); }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`Jev request failed: ${response.status}`);
  }
  let value: unknown;
  try { value = await response.json(); } catch { return invalid(); }
  if (!isRecord(value) || !isRecord(value.answers)) return invalid();
  return {
    area: answer(value.answers.area, ['Tech', 'Business', 'Ideas', 'none']),
    libtype: answer(value.answers.libtype, ['Videos', 'Repos', 'Tools', 'Articles', 'none']),
    topic: answer(value.answers.topic, [...topics, 'none']),
  };
}
export function plan(answers: Answers): { lists: [string, string][]; topic: string | null } {
  const lists: [string, string][] = [];
  if (answers.area.choice !== 'none') lists.push(['Research', answers.area.choice]);
  if (answers.libtype.choice !== 'none') lists.push(['Library', answers.libtype.choice]);
  const best = Object.entries(answers.topic.probabilities).filter(([name]) => name !== 'none').sort((a, b) => b[1] - a[1])[0];
  // ponytail: 0.5 is the tunable minimum topic probability.
  return { lists, topic: best && best[1] >= 0.5 ? best[0] : null };
}
