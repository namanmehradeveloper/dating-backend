// The interest catalogue: seeding, listing, and turning ids or labels into stored interest ids.

import { DEFAULT_INTERESTS } from '../config/catalog.js';
import { Interest } from '../models/Interest.js';

// Inserts the default interests when the collection is empty (first start or a fresh test database).
export async function ensureDefaultInterests() {
  if ((await Interest.estimatedDocumentCount()) > 0) return;
  try {
    await Interest.insertMany(DEFAULT_INTERESTS, { ordered: false });
  } catch (error) {
    // Another request seeded at the same time; duplicates are expected and harmless.
    if (error?.code !== 11000 && !error?.writeErrors) throw error;
  }
}

// Returns every interest as { id, label, category } in display order.
export async function listInterests() {
  await ensureDefaultInterests();
  const interests = await Interest.find().sort({ order: 1 }).lean();
  return interests.map((interest) => ({ id: interest._id, label: interest.label, category: interest.category }));
}

// Returns a Map of interest id -> label for the given ids (used to show labels on profiles).
export async function loadInterestLabels(interestIds) {
  const uniqueIds = [...new Set(interestIds)];
  if (uniqueIds.length === 0) return new Map();
  const interests = await Interest.find({ _id: { $in: uniqueIds } }).lean();
  return new Map(interests.map((interest) => [interest._id, interest.label]));
}

// Returns true when every value is the id of a known interest (onboarding and PUT /profile/interests).
export async function areKnownInterestIds(interestIds) {
  await ensureDefaultInterests();
  const count = await Interest.countDocuments({ _id: { $in: interestIds } });
  return count === new Set(interestIds).size;
}

// Converts ids such as "int_hiking" or labels such as "Hiking" to interest ids.
// Returns null when any value is unknown.
export async function resolveInterestIds(values) {
  await ensureDefaultInterests();
  const interests = await Interest.find().lean();
  const resolved = [];

  for (const value of values) {
    const lowered = value.trim().toLowerCase();
    const interest = interests.find((item) => item._id === value || item.label.toLowerCase() === lowered);
    if (!interest) return null;
    resolved.push(interest._id);
  }
  return [...new Set(resolved)];
}
