// A member's help request with its conversation between the member and support staff.
// Guest tickets have userId null and rely on contactName/contactEmail.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const TICKET_CATEGORIES = ['ACCOUNT', 'BILLING', 'SAFETY', 'BUG', 'OTHER'];
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
export const GUEST_AUTHOR_ID = 'guest';

const ticketMessageSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('tkm'),
    author: { type: String, enum: ['USER', 'STAFF'], required: true },
    authorId: { type: String, required: true },
    body: { type: String, required: true },
    // Client Idempotency-Key for member follow-ups (prevents duplicate inserts).
    idempotencyKey: { type: String },
  },
  { timestamps: true },
);

const supportTicketSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('tkt'),
    userId: { type: String, default: null },
    contactName: { type: String, required: true },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    category: { type: String, enum: TICKET_CATEGORIES, required: true },
    subject: { type: String, required: true },
    status: { type: String, enum: TICKET_STATUSES, default: 'OPEN' },
    // Client Idempotency-Key for create (UUID); unique when present.
    idempotencyKey: { type: String },
    messages: { type: [ticketMessageSchema], default: [] },
  },
  { timestamps: true },
);

supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ contactEmail: 1, createdAt: -1 });
supportTicketSchema.index({ contactName: 1, createdAt: -1 });
supportTicketSchema.index(
  { idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

export const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
