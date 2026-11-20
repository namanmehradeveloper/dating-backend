import { LoginHistory } from '../../models/LoginHistory.js';
import { Profile } from '../../models/Profile.js';
import { User } from '../../models/User.js';
import { mergeFilters, paginationMeta, pickPageMeta, queryPage } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { loadUserCards } from './adminPresenter.js';

const USER_SEARCH_CAP = 500;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function emptyList(pagination) {
  return {
    items: [],
    ...pickPageMeta({ nextCursor: null, ...paginationMeta({ page: pagination.page ?? 1, limit: pagination.limit, total: 0 }) }),
  };
}

async function findMatchingUserIds(query) {
  if (!query) return undefined;
  if (isValidId(query)) return query.startsWith('usr_') ? [query] : [];

  const pattern = new RegExp(escapeRegex(query), 'i');
  const [users, profiles] = await Promise.all([
    User.find({ $or: [{ email: pattern }, { phoneNumber: pattern }] }).select('_id').limit(USER_SEARCH_CAP).lean(),
    Profile.find({ displayName: pattern }).select('userId').limit(USER_SEARCH_CAP).lean(),
  ]);
  return [...new Set([...users.map((user) => user._id), ...profiles.map((profile) => profile.userId)])];
}

export async function listLoginActivity(filters, pagination) {
  const userIds = await findMatchingUserIds(filters.q);
  if (userIds?.length === 0) return emptyList(pagination);

  const dateFilter = {};
  if (filters.fromDate || filters.toDate) {
    dateFilter.loginAt = {};
    if (filters.fromDate) dateFilter.loginAt.$gte = filters.fromDate;
    if (filters.toDate) dateFilter.loginAt.$lt = filters.toDate;
  }
  const baseFilter = mergeFilters(userIds ? { userId: { $in: userIds } } : {}, dateFilter);
  const { docs, ...meta } = await queryPage(LoginHistory, baseFilter, pagination, { dateField: 'loginAt' });
  const cardFor = await loadUserCards(docs.map((entry) => entry.userId));

  return {
    items: docs.map((entry) => ({
      id: entry._id,
      user: cardFor(entry.userId),
      ipAddress: entry.ipAddress ?? null,
      country: entry.country ?? null,
      state: entry.state ?? null,
      city: entry.city ?? null,
      deviceName: entry.deviceName,
      deviceType: entry.deviceType,
      browser: entry.browser,
      operatingSystem: entry.operatingSystem,
      loginAt: entry.loginAt,
    })),
    ...pickPageMeta(meta),
  };
}
