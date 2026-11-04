// Block lookups used everywhere a member could see or reach another member.

import { Block } from '../models/Block.js';

// Returns true when either member has blocked the other.
export async function isBlockedEitherWay(userIdA, userIdB) {
  const block = await Block.exists({
    $or: [
      { blockerId: userIdA, blockedId: userIdB },
      { blockerId: userIdB, blockedId: userIdA },
    ],
  });
  return Boolean(block);
}

// Returns true when `blockerId` has blocked `blockedId` (one direction only).
export async function hasBlocked(blockerId, blockedId) {
  return Boolean(await Block.exists({ blockerId, blockedId }));
}

// Returns the ids of everyone this member blocked or was blocked by.
export async function getBlockedUserIds(userId) {
  const blocks = await Block.find({ $or: [{ blockerId: userId }, { blockedId: userId }] }).lean();
  return blocks.map((block) => (block.blockerId === userId ? block.blockedId : block.blockerId));
}
