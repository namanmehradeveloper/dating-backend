import mongoose from 'mongoose';

export const CALL_TYPES = ['AUDIO', 'VIDEO'];
export const CALL_STATUSES = ['RINGING', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'MISSED', 'BUSY', 'ENDED'];
export const ACTIVE_CALL_STATUSES = ['RINGING', 'ACCEPTED'];

const callSchema = new mongoose.Schema(
  {
    conversationId: { type: String, required: true, index: true },
    callerId: { type: String, required: true },
    calleeId: { type: String, required: true },
    type: { type: String, enum: CALL_TYPES, required: true },
    status: { type: String, enum: CALL_STATUSES, required: true, default: 'RINGING' },
    channelName: { type: String, required: true, unique: true },
    callerAgoraUid: { type: Number, required: true },
    calleeAgoraUid: { type: Number, required: true },
    activeParticipants: { type: [String], default: undefined },
    ringExpiresAt: { type: Date, required: true },
    acceptedAt: Date,
    endedAt: Date,
  },
  { timestamps: true },
);

callSchema.index({ activeParticipants: 1 }, { unique: true, sparse: true });
callSchema.index({ callerId: 1, createdAt: -1 });
callSchema.index({ calleeId: 1, createdAt: -1 });

export const Call = mongoose.model('Call', callSchema);
