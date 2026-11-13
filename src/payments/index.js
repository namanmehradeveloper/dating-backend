// Resolves the active payment provider from env. Controllers must never import adapters directly.

import { ApiError } from '../utils/ApiError.js';
import { env } from '../config/env.js';
import { demoPaymentProvider } from './demo.provider.js';
import { razorpayPaymentProvider } from './razorpay.provider.js';

const PROVIDERS = Object.freeze({
  demo: demoPaymentProvider,
  razorpay: razorpayPaymentProvider,
});

export function listPaymentProviders() {
  return Object.values(PROVIDERS).map((provider) => ({
    name: provider.name,
    environment: provider.environment,
    configured: provider.isConfigured,
    active: provider.name === env.payments.provider,
  }));
}

export function getPaymentProvider(name = env.payments.provider) {
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', { message: `Unknown payment provider: ${name}` });
  }
  if (!provider.isConfigured) {
    throw new ApiError('FEATURE_NOT_CONFIGURED', {
      message:
        provider.name === 'demo'
          ? 'Demo payments are not enabled on this server.'
          : `${provider.name} is not configured yet.`,
    });
  }
  return provider;
}

export function getPaymentProviderByName(name) {
  const provider = PROVIDERS[name];
  if (!provider) throw ApiError.notFound('Unknown payment provider.');
  return provider;
}

export { demoPaymentProvider, razorpayPaymentProvider };
