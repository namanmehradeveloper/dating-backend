// Rolling daily quota for opening support tickets (5 per user or guest IP).
// Updates are atomic so concurrent creates cannot exceed the limit.

import mongoose from 'mongoose';

const supportTicketQuotaSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    count: { type: Number, required: true, min: 0 },
    windowEndsAt: { type: Date, required: true },
  },
  { timestamps: true },
);

supportTicketQuotaSchema.index({ key: 1 }, { unique: true });

export const SupportTicketQuota = mongoose.model('SupportTicketQuota', supportTicketQuotaSchema);
