// Health route: GET /api/v1/health (public).

import { Router } from 'express';
import { getHealth } from '../controllers/health.controller.js';

const router = Router();

// GET /api/v1/health — 200 when the API and MongoDB are up, otherwise 503 with the database state (public).
router.get('/', getHealth);

export default router;
