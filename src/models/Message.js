// A chat message: text, a photo, or both. REST is the source of truth; Socket.IO only announces saved messages.
// The unique senderId + clientMessageId index makes retried sends return the same message.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

// A copy of the attached image's details, so messages can be listed without loading Media records.
const attachmentSchema = new mongoose.Schema(
  {
    mediaId: { type: String, required: true },
    relativePath: { type: String, required: true },
    contentType: { type: String, required: true },
    width: Number,
    height: Number,
  },
  { _id: false },
);

const messageSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('msg'),
    conversationId: { type: String, required: true },
    senderId: { type: String, required: true },
    text: { type: String, default: '' },
    attachment: { type: attachmentSchema, default: null },
    clientMessageId: String,
    sentAt: { type: Date, default: Date.now },
    readAt: Date,
    // Per-user hide ("Delete for me"). The row stays for the other participant.
    hiddenFor: { type: [String], default: [] },
    // Sender unsend ("Delete for everyone"). Content is cleared; placeholder remains.
    unsentAt: Date,
    unsentBy: String,
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, sentAt: -1, _id: -1 });
messageSchema.index(
  { senderId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: 'string' } } },
);
messageSchema.index({ 'attachment.mediaId': 1 }, { partialFilterExpression: { 'attachment.mediaId': { $type: 'string' } } });

export const Message = mongoose.model('Message', messageSchema);
