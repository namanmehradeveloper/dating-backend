// Critical race test: two mutual LIKE requests sent at the same time must create exactly one
// match and one conversation.

import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { Conversation } from '../../src/models/Conversation.js';
import { Match } from '../../src/models/Match.js';
import { createMember, useTestDatabase } from '../helpers/factories.js';
import { swipe } from '../helpers/social.js';

const app = createApp();

describe('concurrent mutual likes', () => {
  useTestDatabase();

  it('creates exactly one match and one conversation per pair', async () => {
    const pairs = [];
    for (let index = 0; index < 10; index += 1) {
      pairs.push([await createMember(), await createMember()]);
    }

    const results = await Promise.all(
      pairs.flatMap(([first, second]) => [swipe(app, first, second.id, 'LIKE'), swipe(app, second, first.id, 'LIKE')]),
    );

    expect(results.every((res) => res.status === 200)).toBe(true);
    expect(await Match.countDocuments()).toBe(10);
    expect(await Conversation.countDocuments()).toBe(10);

    for (let index = 0; index < pairs.length; index += 1) {
      const [firstRes, secondRes] = [results[index * 2], results[index * 2 + 1]];
      expect(firstRes.body.data.isMatch || secondRes.body.data.isMatch).toBe(true);

      const matchIds = [firstRes, secondRes].filter((res) => res.body.data.isMatch).map((res) => res.body.data.match.id);
      expect(new Set(matchIds).size).toBe(1);
    }

    const matches = await Match.find().lean();
    for (const match of matches) {
      expect(await Conversation.countDocuments({ matchId: match._id })).toBe(1);
    }
  });
});
