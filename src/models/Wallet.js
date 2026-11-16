// Per-member coin balance for the virtual goods store.

import mongoose from 'mongoose';

const walletSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // userId
    userId: { type: String, required: true, unique: true },
    coinBalance: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true },
);

export const Wallet = mongoose.model('Wallet', walletSchema);
