// Fixed content the app relies on: the interest list (seeded into MongoDB), support FAQs,
// subscription products and the safe admin-editable settings with their defaults.

// 24 interests in 6 categories. Ids are stable because profiles store them.
export const DEFAULT_INTERESTS = [
  ['int_hiking', 'Hiking', 'Outdoors'],
  ['int_camping', 'Camping', 'Outdoors'],
  ['int_cycling', 'Cycling', 'Outdoors'],
  ['int_running', 'Running', 'Outdoors'],
  ['int_coffee', 'Coffee', 'Food & Drink'],
  ['int_cooking', 'Cooking', 'Food & Drink'],
  ['int_wine', 'Wine', 'Food & Drink'],
  ['int_street_food', 'Street food', 'Food & Drink'],
  ['int_photography', 'Photography', 'Arts'],
  ['int_painting', 'Painting', 'Arts'],
  ['int_music', 'Music', 'Arts'],
  ['int_theatre', 'Theatre', 'Arts'],
  ['int_movies', 'Movies', 'Entertainment'],
  ['int_board_games', 'Board games', 'Entertainment'],
  ['int_gaming', 'Gaming', 'Entertainment'],
  ['int_comedy', 'Stand-up comedy', 'Entertainment'],
  ['int_yoga', 'Yoga', 'Wellness'],
  ['int_meditation', 'Meditation', 'Wellness'],
  ['int_fitness', 'Fitness', 'Wellness'],
  ['int_dancing', 'Dancing', 'Wellness'],
  ['int_travel', 'Travel', 'Lifestyle'],
  ['int_reading', 'Reading', 'Lifestyle'],
  ['int_pets', 'Pets', 'Lifestyle'],
  ['int_volunteering', 'Volunteering', 'Lifestyle'],
].map(([id, label, category], order) => ({ _id: id, label, category, order }));

export const FAQS = [
  {
    id: 'faq_verify_phone',
    category: 'ACCOUNT',
    question: 'How do I sign in?',
    answer: 'Enter your mobile number and the 6-digit code we give you. Your number is never shown on your profile.',
  },
  {
    id: 'faq_delete_account',
    category: 'ACCOUNT',
    question: 'How do I delete my account?',
    answer: 'Go to Settings > Account > Delete account. Your profile is hidden immediately and deleted after 14 days. Signing in again during that time cancels the deletion.',
  },
  {
    id: 'faq_block_report',
    category: 'SAFETY',
    question: 'How do I block or report someone?',
    answer: 'Open their profile or your chat with them and choose Block or Report. They are not told who blocked or reported them.',
  },
  {
    id: 'faq_verification',
    category: 'SAFETY',
    question: 'What does the verified badge mean?',
    answer: 'The member took a selfie that our team compared with their profile photos.',
  },
  {
    id: 'faq_subscription_cancel',
    category: 'BILLING',
    question: 'How do I cancel my subscription?',
    answer: 'Subscriptions are managed by the App Store or Google Play. Cancel from your store account settings.',
  },
  {
    id: 'faq_likes_limit',
    category: 'BILLING',
    question: 'Why can\'t I like more profiles today?',
    answer: 'Free members have a daily number of likes. It resets 24 hours after your earlier likes. Plus members have unlimited likes.',
  },
];

// Paywall products. amountMinor is the canonical charge in the smallest currency unit (paise).
export const SUBSCRIPTION_PRODUCTS = [
  {
    id: 'dc_plus_monthly',
    tier: 'PLUS',
    title: 'Plus',
    description: 'Unlimited likes, see who likes you and undo.',
    priceLabel: '₹499',
    period: 'MONTHLY',
    amountMinor: 49900,
    currency: 'INR',
  },
  {
    id: 'dc_plus_yearly',
    tier: 'PLUS',
    title: 'Plus (yearly)',
    description: 'Everything in Plus for a whole year.',
    priceLabel: '₹3,999',
    period: 'YEARLY',
    amountMinor: 399900,
    currency: 'INR',
  },
];

export function findSubscriptionProduct(productId) {
  return SUBSCRIPTION_PRODUCTS.find((product) => product.id === productId) ?? null;
}

// Virtual goods: coin packs (money → coins), emoji packs, and gifts sent in chat.
export const DEFAULT_STORE_ITEMS = [
  {
    _id: 'coins_100',
    kind: 'COIN_PACK',
    title: '100 Coins',
    description: 'A small top-up for gifts and emoji packs.',
    emoji: '🪙',
    priceMoneyMinor: 4900,
    currency: 'INR',
    coinAmount: 100,
    sortOrder: 10,
  },
  {
    _id: 'coins_500',
    kind: 'COIN_PACK',
    title: '500 Coins',
    description: 'Best for regular gifters.',
    emoji: '💰',
    priceMoneyMinor: 19900,
    currency: 'INR',
    coinAmount: 500,
    sortOrder: 20,
  },
  {
    _id: 'coins_1200',
    kind: 'COIN_PACK',
    title: '1,200 Coins',
    description: 'Biggest pack — extra coins included.',
    emoji: '💎',
    priceMoneyMinor: 39900,
    currency: 'INR',
    coinAmount: 1200,
    sortOrder: 30,
  },
  {
    _id: 'emoji_pack_hearts',
    kind: 'EMOJI_PACK',
    title: 'Hearts Pack',
    description: 'Premium heart emojis for your matches.',
    emoji: '💕',
    emojis: ['💕', '💖', '💗', '💓', '💞', '💘'],
    priceCoins: 80,
    sortOrder: 40,
  },
  {
    _id: 'emoji_pack_neon',
    kind: 'EMOJI_PACK',
    title: 'Neon Pack',
    description: 'Bold neon vibes for late-night chats.',
    emoji: '✨',
    emojis: ['✨', '🔥', '⚡', '🌟', '💫', '🪩'],
    priceCoins: 120,
    sortOrder: 50,
  },
  {
    _id: 'gift_wave',
    kind: 'GIFT',
    title: 'Wave',
    description: 'A free hello during calls and chat.',
    emoji: '👋',
    priceCoins: 0,
    giftCategory: 'FREE',
    sortOrder: 55,
  },
  {
    _id: 'gift_rose',
    kind: 'GIFT',
    title: 'Rose',
    description: 'A classic first move.',
    emoji: '🌹',
    priceCoins: 10,
    giftCategory: 'POPULAR',
    sortOrder: 60,
  },
  {
    _id: 'gift_heart',
    kind: 'GIFT',
    title: 'Heart',
    description: 'Send some love live.',
    emoji: '💖',
    priceCoins: 20,
    giftCategory: 'POPULAR',
    sortOrder: 65,
  },
  {
    _id: 'gift_coffee',
    kind: 'GIFT',
    title: 'Coffee',
    description: 'Say let’s grab a drink.',
    emoji: '☕',
    priceCoins: 40,
    giftCategory: 'POPULAR',
    sortOrder: 70,
  },
  {
    _id: 'gift_teddy',
    kind: 'GIFT',
    title: 'Teddy',
    description: 'Soft and thoughtful.',
    emoji: '🧸',
    priceCoins: 50,
    giftCategory: 'POPULAR',
    sortOrder: 80,
  },
  {
    _id: 'gift_chocolate',
    kind: 'GIFT',
    title: 'Chocolate',
    description: 'Sweet and simple.',
    emoji: '🍫',
    priceCoins: 100,
    giftCategory: 'PREMIUM',
    sortOrder: 90,
  },
  {
    _id: 'gift_sparkler',
    kind: 'GIFT',
    title: 'Sparkler',
    description: 'Celebrate a great chat.',
    emoji: '🎇',
    priceCoins: 90,
    giftCategory: 'PREMIUM',
    sortOrder: 100,
  },
  {
    _id: 'gift_ring',
    kind: 'GIFT',
    title: 'Ring',
    description: 'A dazzling premium gesture.',
    emoji: '💍',
    priceCoins: 500,
    giftCategory: 'PREMIUM',
    sortOrder: 105,
  },
  {
    _id: 'gift_crown',
    kind: 'GIFT',
    title: 'Crown',
    description: 'Make them feel special.',
    emoji: '👑',
    priceCoins: 1000,
    giftCategory: 'PREMIUM',
    sortOrder: 110,
  },
];

/** Call/chat gift ids kept in sync even when the catalogue was seeded earlier. */
export const CALL_GIFT_SYNC_IDS = [
  'gift_wave',
  'gift_rose',
  'gift_heart',
  'gift_teddy',
  'gift_chocolate',
  'gift_ring',
  'gift_crown',
];

export function findStoreItemDefinition(itemId) {
  return DEFAULT_STORE_ITEMS.find((item) => item._id === itemId) ?? null;
}

export function periodDurationMs(period) {
  if (period === 'YEARLY') return 365 * 24 * 60 * 60 * 1000;
  return 30 * 24 * 60 * 60 * 1000;
}

// Settings admins may change, with their default values and allowed ranges.
export const EDITABLE_SETTINGS = {
  freeDailyLikes: { defaultValue: 50, min: 1, max: 1000 },
  freeDailySuperLikes: { defaultValue: 1, min: 0, max: 100 },
  // 0 = rewind is premium-only (default). Free members get this many undos per 24h when > 0.
  freeDailyRewinds: { defaultValue: 0, min: 0, max: 50 },
  // Swipes in 24h that flag a member on the admin swipe-abuse queue.
  swipeAbuseThresholdPerDay: { defaultValue: 80, min: 20, max: 2000 },
  // Match expiry in days (0 = never). Applied to newly created matches as expiresAt.
  matchExpiryDays: { defaultValue: 0, min: 0, max: 365 },
  // ACTIVE matches with no messages older than this many days count as inactive in admin stats.
  matchInactiveDays: { defaultValue: 7, min: 1, max: 90 },
  // Numeric algorithm version stamped on new matches (displayed as v{n}).
  matchAlgorithmVersion: { defaultValue: 1, min: 1, max: 99 },
  // New matches / 24h for one member that flag the suspicious-matches queue.
  matchFraudNewMatchesPerDay: { defaultValue: 25, min: 5, max: 500 },
  // Blocks created / 24h that flag a member on the admin block-velocity queue.
  blockAbuseThresholdPerDay: { defaultValue: 20, min: 5, max: 500 },
  verificationDailyLimit: { defaultValue: 3, min: 1, max: 20 },
};
