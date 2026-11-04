// An application setting that admins may change from the admin panel (only safe, approved keys).

import mongoose from 'mongoose';

const appSettingSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true },
    updatedBy: String,
  },
  { timestamps: true },
);

appSettingSchema.index({ key: 1 }, { unique: true });

export const AppSetting = mongoose.model('AppSetting', appSettingSchema);
