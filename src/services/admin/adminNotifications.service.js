// Staff notification campaigns: an inbox entry for every member in the chosen audience.
// Push delivery is not configured, so campaigns record pushStatus FEATURE_NOT_CONFIGURED honestly.
// Promotions only reach members who switched promotions on.

import { Notification } from '../../models/Notification.js';
import { NotificationCampaign } from '../../models/NotificationCampaign.js';
import { NotificationPreference } from '../../models/NotificationPreference.js';
import { SubscriptionEntitlement } from '../../models/SubscriptionEntitlement.js';
import { User } from '../../models/User.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { recordAudit } from '../audit.service.js';
import { isPushConfigured } from '../push.service.js';
import { loadUserCards } from './adminPresenter.js';

const INSERT_BATCH_SIZE = 1000;

// Members who can receive notifications: not banned and not leaving the app.
function reachableMemberFilter() {
  return { role: 'USER', status: { $ne: 'BANNED' }, 'deletion.status': { $ne: 'SCHEDULED' } };
}

// Returns the ids of members with an active, unexpired premium entitlement.
async function findPremiumUserIds() {
  const entitlements = await SubscriptionEntitlement.find({
    isActive: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .select('userId')
    .lean();
  return entitlements.map((entitlement) => entitlement.userId);
}

// Returns the member ids a campaign goes to.
async function resolveAudience({ audience, targetUserId }) {
  const base = reachableMemberFilter();
  if (audience === 'SINGLE_USER') {
    const target = await User.findOne({ _id: targetUserId, ...base }).select('_id').lean();
    if (!target) throw ApiError.notFound('That member does not exist or cannot receive notifications.');
    return [target._id];
  }

  let filter = base;
  if (audience === 'VERIFIED_USERS') filter = { ...base, verificationStatus: 'VERIFIED' };
  if (audience === 'PREMIUM_USERS') filter = { ...base, _id: { $in: await findPremiumUserIds() } };
  if (audience === 'FREE_USERS') filter = { ...base, _id: { $nin: await findPremiumUserIds() } };
  const users = await User.find(filter).select('_id').lean();
  return users.map((user) => user._id);
}

// Keeps only members who opted in to promotions (the default is off).
async function keepPromotionSubscribers(userIds) {
  const optedIn = await NotificationPreference.find({ userId: { $in: userIds }, promotions: true }).select('userId').lean();
  return optedIn.map((preference) => preference.userId);
}

// Writes the inbox entries in batches.
async function createInboxEntries(campaign, userIds) {
  for (let start = 0; start < userIds.length; start += INSERT_BATCH_SIZE) {
    const batch = userIds.slice(start, start + INSERT_BATCH_SIZE).map((userId) => ({
      userId,
      type: 'SYSTEM',
      title: campaign.title,
      body: campaign.body,
      data: { campaignId: campaign._id },
      campaignId: campaign._id,
    }));
    await Notification.insertMany(batch);
  }
}

// Shapes one campaign for the admin panel.
function presentCampaign(campaign, cardFor) {
  return {
    id: campaign._id,
    title: campaign.title,
    body: campaign.body,
    type: campaign.type,
    audience: campaign.audience,
    targetUserId: campaign.targetUserId ?? null,
    recipientCount: campaign.recipientCount,
    pushStatus: campaign.pushStatus,
    createdBy: cardFor(campaign.createdBy),
    createdAt: campaign.createdAt,
  };
}

// GET /admin/notifications — sent campaigns, newest first.
export async function listCampaigns(filters = {}, { limit, cursor } = {}) {
  const query = {};
  if (filters.q) {
    const pattern = new RegExp(filters.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [{ title: pattern }, { body: pattern }, { _id: filters.q }, { targetUserId: filters.q }];
  }
  const docs = await NotificationCampaign.find(mergeFilters(query, getAfterCursorFilter(cursor))).sort(getPageSort()).limit(limit + 1).lean();
  const page = buildPage(docs, limit);
  const cardFor = await loadUserCards(page.items.map((campaign) => campaign.createdBy));
  return { items: page.items.map((campaign) => presentCampaign(campaign, cardFor)), nextCursor: page.nextCursor };
}

// POST /admin/notifications — sends a campaign and returns it with the real recipient count.
export async function sendCampaign(actor, input) {
  let recipientIds = await resolveAudience(input);
  if (input.type === 'PROMOTION') recipientIds = await keepPromotionSubscribers(recipientIds);

  const campaign = await NotificationCampaign.create({
    ...input,
    createdBy: actor.id,
    recipientCount: recipientIds.length,
    pushStatus: isPushConfigured() ? 'SENT' : 'FEATURE_NOT_CONFIGURED',
  });
  await createInboxEntries(campaign, recipientIds);

  await recordAudit(actor, {
    action: 'NOTIFICATION_SENT',
    targetType: input.audience === 'SINGLE_USER' ? 'USER' : 'NOTIFICATION_CAMPAIGN',
    targetId: input.audience === 'SINGLE_USER' ? input.targetUserId : campaign._id,
    metadata: { campaignId: campaign._id, type: input.type, audience: input.audience, recipientCount: recipientIds.length },
  });
  return presentCampaign(campaign.toObject(), await loadUserCards([actor.id]));
}
