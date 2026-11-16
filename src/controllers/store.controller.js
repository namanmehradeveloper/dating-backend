// HTTP handlers for /store member endpoints.

import { ApiResponse } from '../utils/ApiResponse.js';
import { parsePagination } from '../utils/pagination.js';
import * as storeService from '../services/store.service.js';
import {
  validateBuyWithCoins,
  validateStoreCheckout,
  validateStoreVerify,
} from '../validators/store.validator.js';

export async function getCatalog(req, res) {
  return ApiResponse.ok(res, await storeService.listCatalog());
}

export async function getWallet(req, res) {
  return ApiResponse.ok(res, await storeService.getWallet(req.user.id));
}

export async function createCheckout(req, res) {
  const input = validateStoreCheckout(req.body);
  return ApiResponse.ok(res, await storeService.createCheckout(req.user.id, input));
}

export async function verifyPurchase(req, res) {
  const input = validateStoreVerify(req.body);
  return ApiResponse.ok(res, await storeService.verifyPurchase(req.user.id, input));
}

export async function buyWithCoins(req, res) {
  const input = validateBuyWithCoins(req.body);
  return ApiResponse.ok(res, await storeService.buyWithCoins(req.user.id, input));
}

export async function getHistory(req, res) {
  return ApiResponse.ok(res, await storeService.listPurchaseHistory(req.user.id, parsePagination(req.query)));
}
