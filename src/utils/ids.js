// Creates the prefixed ids used in the API (usr_…, med_…, mat_…), matching the documented examples.

import mongoose from 'mongoose';

// Returns a new id such as "usr_665f1c2e9b1d4a0012345678". The hex part is a MongoDB ObjectId,
// so ids sort roughly by creation time, which keeps cursor tie-breaking stable.
export function newId(prefix) {
  return `${prefix}_${new mongoose.Types.ObjectId().toHexString()}`;
}

// Mongoose field definition for a string primary key with the given prefix.
export function prefixedIdField(prefix) {
  return { type: String, default: () => newId(prefix) };
}
