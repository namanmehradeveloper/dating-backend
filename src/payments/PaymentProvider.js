// Common contract every payment adapter must implement. Controllers never call provider APIs
// directly — they go through subscription.service, which selects the configured provider.

/**
 * @typedef {object} CheckoutInput
 * @property {string} userId
 * @property {object} product
 * @property {'IOS'|'ANDROID'|'WEB'} platform
 * @property {string} [idempotencyKey]
 * @property {string} checkoutId
 */

/**
 * @typedef {object} CheckoutResult
 * @property {string} checkoutId
 * @property {string} provider
 * @property {string} environment
 * @property {string} [providerRef]
 * @property {Date} [checkoutExpiresAt]
 * @property {object} [clientPayload] Opaque fields the client needs to complete payment UI.
 * @property {object} [providerMeta]
 */

/**
 * @typedef {object} VerifyInput
 * @property {string} userId
 * @property {import('../models/PaymentTransaction.js').PaymentTransaction} transaction
 * @property {object} [providerProof]
 */

/**
 * @typedef {object} VerifyResult
 * @property {'SUCCEEDED'|'FAILED'} status
 * @property {string} [providerRef]
 * @property {string} originalTransactionId
 * @property {string} [failureReason]
 * @property {object} [providerMeta]
 * @property {Date} expiresAt Entitlement end date after a successful charge.
 * @property {boolean} willRenew
 */

/**
 * @typedef {object} RestoreInput
 * @property {string} userId
 * @property {'IOS'|'ANDROID'|'WEB'} platform
 * @property {unknown[]} providerProofs
 */

/**
 * @typedef {object} CancelInput
 * @property {string} userId
 * @property {object} entitlement
 * @property {string} [reason]
 */

/**
 * @typedef {object} WebhookInput
 * @property {object} headers
 * @property {unknown} rawBody
 * @property {unknown} body
 */

export class PaymentProvider {
  /** @returns {string} */
  get name() {
    throw new Error('PaymentProvider.name must be implemented');
  }

  /** @returns {string} demo | test | live */
  get environment() {
    throw new Error('PaymentProvider.environment must be implemented');
  }

  /** @returns {boolean} */
  get isConfigured() {
    return false;
  }

  /**
   * @param {CheckoutInput} _input
   * @returns {Promise<CheckoutResult>}
   */
  async createCheckout(_input) {
    throw new Error('createCheckout must be implemented');
  }

  /**
   * @param {VerifyInput} _input
   * @returns {Promise<VerifyResult>}
   */
  async verifyPayment(_input) {
    throw new Error('verifyPayment must be implemented');
  }

  /**
   * @param {RestoreInput} _input
   * @returns {Promise<VerifyResult[]>}
   */
  async restorePurchase(_input) {
    throw new Error('restorePurchase must be implemented');
  }

  /**
   * @param {CancelInput} _input
   * @returns {Promise<{ willRenew: boolean, cancelledAt: Date }>}
   */
  async cancelSubscription(_input) {
    throw new Error('cancelSubscription must be implemented');
  }

  /**
   * @param {WebhookInput} _input
   * @returns {Promise<{ handled: boolean, events?: object[] }>}
   */
  async handleWebhook(_input) {
    throw new Error('handleWebhook must be implemented');
  }
}
