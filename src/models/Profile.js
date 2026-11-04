// A member's dating profile created by onboarding: public details, photos, private
// date of birth/gender/location, discovery preferences, and admin-managed visibility.

import mongoose from 'mongoose';
import { prefixedIdField } from '../utils/ids.js';

export const GENDERS = ['WOMAN', 'MAN', 'NON_BINARY'];
export const SHOW_ME_OPTIONS = ['WOMEN', 'MEN', 'EVERYONE'];
export const RELATIONSHIP_GOALS = [
  'LONG_TERM',
  'LONG_TERM_OPEN_TO_SHORT',
  'SHORT_TERM_OPEN_TO_LONG',
  'SHORT_TERM_FUN',
  'NEW_FRIENDS',
  'STILL_FIGURING_OUT',
];
export const PHOTO_MODERATION_STATUSES = ['PENDING', 'APPROVED', 'REJECTED'];
export const VISIBILITY_STATUSES = ['VISIBLE', 'HIDDEN', 'PAUSED', 'SNOOZED'];

const photoSchema = new mongoose.Schema({
  _id: prefixedIdField('pho'),
  mediaId: { type: String, required: true },
  relativePath: { type: String, required: true },
  order: { type: Number, required: true },
  moderationStatus: { type: String, enum: PHOTO_MODERATION_STATUSES, default: 'APPROVED' },
  moderationReason: String,
  moderatedAt: Date,
  moderatedBy: String,
});

const preferencesSchema = new mongoose.Schema(
  {
    minAge: { type: Number, default: 18 },
    maxAge: { type: Number, default: 99 },
    maxDistanceKm: { type: Number, default: 80 },
    showMe: { type: String, enum: SHOW_ME_OPTIONS, default: 'EVERYONE' },
  },
  { _id: false },
);

const boostSchema = new mongoose.Schema(
  {
    active: { type: Boolean, default: false },
    expiresAt: Date,
    activatedAt: Date,
  },
  { _id: false },
);

const privacySchema = new mongoose.Schema(
  {
    showAge: { type: Boolean, default: true },
    showDistance: { type: Boolean, default: true },
    showOnlineStatus: { type: Boolean, default: true },
    incognito: { type: Boolean, default: false },
  },
  { _id: false },
);

const profileSchema = new mongoose.Schema(
  {
    _id: prefixedIdField('prf'),
    userId: { type: String, required: true },
    displayName: { type: String, required: true },
    dateOfBirth: { type: Date, required: true },
    gender: { type: String, enum: GENDERS },
    showGender: { type: Boolean, default: false },
    relationshipGoal: { type: String, enum: RELATIONSHIP_GOALS },
    basics: { type: Map, of: String, default: undefined },
    bio: String,
    prompt: {
      type: new mongoose.Schema({ promptId: String, answer: String }, { _id: false }),
      default: undefined,
    },
    interestIds: { type: [String], default: [] },
    photos: { type: [photoSchema], default: [] },
    city: String,
    occupation: String,
    // GeoJSON point [longitude, latitude], rounded to ~1 km. Never returned to other members.
    location: {
      type: new mongoose.Schema(
        { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: [Number] },
        { _id: false },
      ),
      default: undefined,
    },
    preferences: { type: preferencesSchema, default: () => ({}) },
    visibilityStatus: { type: String, enum: VISIBILITY_STATUSES, default: 'VISIBLE' },
    pausedUntil: Date,
    snoozedUntil: Date,
    visibilityNote: String,
    boost: { type: boostSchema, default: () => ({}) },
    privacy: { type: privacySchema, default: () => ({}) },
    acceptedTermsVersion: String,
    acceptedTermsAt: Date,
  },
  { timestamps: true },
);

profileSchema.index({ userId: 1 }, { unique: true });
profileSchema.index({ location: '2dsphere' }, { sparse: true });
profileSchema.index({ createdAt: -1, _id: -1 });
profileSchema.index({ 'photos._id': 1 });
profileSchema.index({ 'photos.moderationStatus': 1 });
profileSchema.index({ visibilityStatus: 1 });

export const Profile = mongoose.model('Profile', profileSchema);
