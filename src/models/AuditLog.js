// A permanent record of one staff action in the admin panel (who did what, to whom, and when).

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

const auditLogSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('aud'),
    actorId: { type: String, required: true },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    // Only safe, non-secret details such as the old and new status.
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ actorId: 1, createdAt: -1 });
auditLogSchema.index({ targetId: 1, createdAt: -1 });

export const AuditLog = mongoose.model('AuditLog', auditLogSchema);
