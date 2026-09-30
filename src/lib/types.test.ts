import { expect, test } from 'vitest';
import { LIMITS } from './types';

test('limits are sane', () => expect(LIMITS.maxSegments).toBeGreaterThan(0));
