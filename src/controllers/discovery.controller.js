// HTTP handlers for discovery, swipes, likes and matches.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import { getDiscoveryFeed } from '../services/discovery.service.js';
import * as matchService from '../services/match.service.js';
import * as swipeService from '../services/swipe.service.js';
import { validateDiscoveryFilters, validateSwipe } from '../validators/discovery.validator.js';

// GET /discovery — candidates for the swipe deck.
export async function getDiscovery(req, res) {
  const pagination = parsePagination(req.query);
  const filters = validateDiscoveryFilters(req.query);
  return ApiResponse.ok(res, await getDiscoveryFeed(req.user.id, filters, pagination));
}

// POST /swipes — like, pass or super-like (idempotent).
export async function createSwipe(req, res) {
  const input = validateSwipe(req.body);
  return ApiResponse.ok(res, await swipeService.recordSwipe(req.user.id, input));
}

// POST /swipes/undo — undo the last swipe (premium).
export async function undoSwipe(req, res) {
  return ApiResponse.ok(res, await swipeService.undoLastSwipe(req.user.id));
}

// GET /likes/received — who liked you (premium; free members get the count in the error).
export async function getReceivedLikes(req, res) {
  return ApiResponse.ok(res, await swipeService.listReceivedLikes(req.user.id, parsePagination(req.query)));
}

// GET /likes/sent — your pending likes.
export async function getSentLikes(req, res) {
  return ApiResponse.ok(res, await swipeService.listSentLikes(req.user.id, parsePagination(req.query)));
}

// GET /matches — active matches, newest first.
export async function getMatches(req, res) {
  return ApiResponse.ok(res, await matchService.listMatches(req.user.id, parsePagination(req.query)));
}

// GET /matches/:matchId — one match, participants only.
export async function getMatch(req, res) {
  return ApiResponse.ok(res, await matchService.getMatch(req.user.id, req.params.matchId));
}

// POST /matches/:matchId/unmatch — end a match.
export async function unmatch(req, res) {
  await matchService.unmatch(req.user.id, req.params.matchId);
  return ApiResponse.ok(res, null);
}
