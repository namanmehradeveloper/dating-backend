// The chat between the two members of a match. Closed when the match ends, after which
// no messages or realtime events are allowed.

import mongoose from 'mongoose';

export const CONVERSATION_STATUSES = ['ACTIVE', 'CLOSED'];

const readStateSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    lastReadAt: Date,
    lastReadMessageId: String,
  },
  { _id: false },
);

const conversationSchema = new mongoose.Schema(
  {
    // The id is chosen when the match is created so the match can reference it.
    _id: { type: String, required: true },
    matchId: { type: String, required: true },
    participantIds: { type: [String], required: true },
    status: { type: String, enum: CONVERSATION_STATUSES, default: 'ACTIVE' },
    lastMessageId: String,
    lastActivityAt: { type: Date, default: Date.now },
    readStates: { type: [readStateSchema], default: [] },
    // Per-user hide ("Delete chat"). Conversation stays for the other participant.
    hiddenFor: { type: [String], default: [] },
    closedAt: Date,
  },
  { timestamps: true },
);

conversationSchema.index({ matchId: 1 }, { unique: true });
conversationSchema.index({ participantIds: 1, status: 1, lastActivityAt: -1 });

export const Conversation = mongoose.model('Conversation', conversationSchema);
