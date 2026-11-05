import { LoginHistory } from '../../models/LoginHistory.js';
import { Profile } from '../../models/Profile.js';
import { User } from '../../models/User.js';
import { buildPage, getAfterCursorFilter, getPageSort, mergeFilters } from '../../utils/pagination.js';
import { isValidId } from '../../validators/common.js';
import { loadUserCards } from './adminPresenter.js';

const USER_SEARCH_CAP = 500;

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export async function listLoginActivity(filters, { limit, cursor }) {
  const userIds = await findMatchingUserIds(filters.q);
  if (userIds?.length === 0) return { items: [], nextCursor: null };

  const dateFilter = {};
  if (filters.fromDate || filters.toDate) {
    dateFilter.loginAt = {};
    if (filters.fromDate) dateFilter.loginAt.$gte = filters.fromDate;
    if (filters.toDate) dateFilter.loginAt.$lt = filters.toDate;
  }
  const docs = await LoginHistory.find(
    mergeFilters(
      userIds ? { userId: { $in: userIds } } : {},
      dateFilter,
      getAfterCursorFilter(cursor, 'loginAt'),
    ),
  )
    .sort(getPageSort('loginAt'))
    .limit(limit + 1)
    .select('userId ipAddress country state city deviceName deviceType browser operatingSystem loginAt')
    .lean();
  const page = buildPage(docs, limit, 'loginAt');
  const cardFor = await loadUserCards(page.items.map((entry) => entry.userId));

  return {
    items: page.items.map((entry) => ({
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
    nextCursor: page.nextCursor,
  };
}
