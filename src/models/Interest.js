// An interest a member can pick during onboarding (for example int_hiking, "Hiking", "Outdoors").

import mongoose from 'mongoose';

const interestSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  label: { type: String, required: true },
  category: { type: String, required: true },
  order: { type: Number, default: 0 },
});

export const Interest = mongoose.model('Interest', interestSchema);
