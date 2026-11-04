// Staff role definition with a module/action permission matrix. System roles are seeded;
// custom roles are created by Super Admins / Admins within rank limits.

import mongoose from 'mongoose';
import { PERMISSION_ACTIONS, PERMISSION_MODULES } from '../config/permissions.catalog.js';
import { prefixedIdField } from '../utils/ids.js';

const permissionEntrySchema = new mongoose.Schema(
  {
    module: { type: String, enum: PERMISSION_MODULES, required: true },
    actions: {
      type: [String],
      enum: PERMISSION_ACTIONS,
      default: [],
    },
  },
  { _id: false },
);

const adminRoleSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('rol'),
    slug: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    rank: { type: Number, required: true, min: 1, max: 100 },
    permissions: { type: [permissionEntrySchema], default: [] },
  },
  { timestamps: true },
);

adminRoleSchema.index({ slug: 1 }, { unique: true });
adminRoleSchema.index({ isSystem: 1, rank: -1 });

export const AdminRole = mongoose.model('AdminRole', adminRoleSchema);
