// A chat message: text, a photo, a call log, or a mix of text/photo. REST is the source of truth;
// Socket.IO only announces saved messages. The unique senderId + clientMessageId index makes retried
// sends return the same message. Call logs use clientMessageId `call:<callId>` for idempotency.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const CALL_MESSAGE_STATUSES = ['REJECTED', 'CANCELLED', 'MISSED', 'BUSY', 'ENDED'];

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

// Snapshot of a finished voice/video call shown in the conversation thread.
const callSchema = new mongoose.Schema(
  {
    callId: { type: String, required: true },
    type: { type: String, enum: ['AUDIO', 'VIDEO'], required: true },
    status: { type: String, enum: CALL_MESSAGE_STATUSES, required: true },
    durationSeconds: { type: Number, default: null },
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
    call: { type: callSchema, default: null },
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
messageSchema.index({ 'call.callId': 1 }, { unique: true, partialFilterExpression: { 'call.callId': { $type: 'string' } } });

export const Message = mongoose.model('Message', messageSchema);
