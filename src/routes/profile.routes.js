// /api/v1/profile routes (own profile, onboarding, preferences, interests, photos, verification).

import { Router } from 'express';
import * as mediaController from '../controllers/media.controller.js';
import * as profileController from '../controllers/profile.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { getSetting } from '../services/settings.service.js';
import { byUser, createRateLimiter, DAY, HOUR } from '../utils/rateLimit.js';

const router = Router();

const onboardingLimit = createRateLimiter({ windowMs: HOUR, max: 10, keyFrom: byUser });
const profileUpdateLimit = createRateLimiter({ windowMs: HOUR, max: 30, keyFrom: byUser });
const verificationLimit = createRateLimiter({
  windowMs: DAY,
  max: () => getSetting('verificationDailyLimit'),
  keyFrom: byUser,
});

router.use(requireAuth);

// GET /api/v1/profile/me — the signed-in member's own profile.
router.get('/me', profileController.getMyProfile);

// GET /api/v1/profile/login-activity — the signed-in member's own login activity.
router.get('/login-activity', profileController.getMyLoginActivity);

// PATCH /api/v1/profile/me — partial profile edit (30 per hour).
router.patch('/me', profileUpdateLimit, profileController.updateMyProfile);

// POST /api/v1/profile/onboarding — create the profile once after the first sign-in (10 per hour).
router.post('/onboarding', onboardingLimit, profileController.completeOnboarding);

// PUT /api/v1/profile/preferences — replace discovery preferences (30 per hour).
router.put('/preferences', profileUpdateLimit, profileController.updatePreferences);

// PUT /api/v1/profile/interests — replace the member's interests (30 per hour).
router.put('/interests', profileUpdateLimit, profileController.replaceInterests);

// POST /api/v1/profile/photos — attach an already uploaded photo to the profile (30 per hour).
router.post('/photos', profileUpdateLimit, mediaController.addPhoto);

// PATCH /api/v1/profile/photos/order — reorder profile photos (30 per hour).
router.patch('/photos/order', profileUpdateLimit, mediaController.reorderPhotos);

// DELETE /api/v1/profile/photos/:photoId — remove a photo and its file (30 per hour).
router.delete('/photos/:photoId', profileUpdateLimit, mediaController.deletePhoto);

// POST /api/v1/profile/verification — submit a selfie for verification review (daily limit from settings).
router.post('/verification', verificationLimit, mediaController.submitVerification);

export default router;
