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
    messages: { type: [ticketMessageSchema], default: [] },
  },
  { timestamps: true },
);

supportTicketSchema.index({ userId: 1, createdAt: -1 });
supportTicketSchema.index({ status: 1, createdAt: -1 });
supportTicketSchema.index({ contactEmail: 1, createdAt: -1 });
supportTicketSchema.index({ contactName: 1, createdAt: -1 });

export const SupportTicket = mongoose.model('SupportTicket', supportTicketSchema);
