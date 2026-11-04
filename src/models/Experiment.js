// A/B experiment definitions. Weights and audience only — no fabricated conversion metrics.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const EXPERIMENT_STATUSES = ['DRAFT', 'RUNNING', 'PAUSED', 'COMPLETED'];

const variantSchema = new mongoose.Schema(
  {
    key: { type: String, required: true },
    weight: { type: Number, required: true },
  },
  { _id: false },
);

const experimentSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('exp'),
    key: { type: String, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: EXPERIMENT_STATUSES, default: 'DRAFT' },
    variants: { type: [variantSchema], default: [] },
    audiencePercent: { type: Number, default: 100 },
    metrics: { type: String, default: '' },
    startedAt: Date,
    endedAt: Date,
    createdBy: String,
  },
  { timestamps: true },
);

experimentSchema.index({ key: 1 }, { unique: true });
experimentSchema.index({ status: 1, createdAt: -1 });

export const Experiment = mongoose.model('Experiment', experimentSchema);
