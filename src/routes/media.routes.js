// /api/v1/media routes: local multipart upload (replaces the old S3 upload-url/complete flow) and metadata.

import { Router } from 'express';
import * as mediaController from '../controllers/media.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';
import { receiveImageUpload } from '../middlewares/upload.middleware.js';
import { byUser, createRateLimiter, HOUR } from '../utils/rateLimit.js';

const router = Router();
const uploadLimit = createRateLimiter({ windowMs: HOUR, max: 30, keyFrom: byUser });

router.use(requireAuth);

// POST /api/v1/media/upload — multipart image upload; saves the file locally and returns mediaId + URL (30 per hour).
router.post('/upload', uploadLimit, receiveImageUpload, mediaController.uploadMedia);

// GET /api/v1/media/:mediaId — media metadata for the owner or another authorised member.
router.get('/:mediaId', mediaController.getMedia);

export default router;
