import { isIP } from 'node:net';
import { LoginHistory } from '../models/LoginHistory.js';
import { logger } from '../utils/logger.js';
import { buildPage, getAfterCursorFilter, getPageSort } from '../utils/pagination.js';

function normalizeIpAddress(value) {
  if (typeof value !== 'string') return undefined;
  const ipAddress = value.trim().replace(/^::ffff:/i, '');
  return isIP(ipAddress) ? ipAddress : undefined;
}

function isPublicIp(ipAddress) {
  const normalized = ipAddress.toLowerCase();
  if (normalized.includes(':')) {
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice(7));
    return normalized !== '::' && normalized !== '::1'
      && !/^f[cd]/.test(normalized)
      && !/^fe[89ab]/.test(normalized);
  }

  const [first, second] = normalized.split('.').map(Number);
  return first !== 0
    && first !== 10
    && first !== 127
    && first < 224
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 168);
}

async function lookupLocation(ipAddress) {
  if (!ipAddress || !isPublicIp(ipAddress)) return {};

  const response = await fetch(`https://ipwho.is/${encodeURIComponent(ipAddress)}`, {
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`Geolocation provider returned ${response.status}`);

  const location = await response.json();
  if (location.success !== true) throw new Error('Geolocation provider could not locate the IP address');

  return {
    country: location.country,
    state: location.region,
    city: location.city,
  };
}

function parseDevice(userAgent = '') {
  const ua = userAgent.toLowerCase();
  const isTablet = /ipad|tablet|playbook|silk/.test(ua) || (/android/.test(ua) && !/mobile/.test(ua));
  const isMobile = !isTablet && /mobile|iphone|ipod|windows phone/.test(ua);
  const deviceType = isTablet ? 'TABLET' : isMobile ? 'MOBILE' : 'DESKTOP';

  let deviceName = 'Unknown device';
  if (/ipad/.test(ua)) deviceName = 'iPad';
  else if (/iphone/.test(ua)) deviceName = 'iPhone';
  else if (/ipod/.test(ua)) deviceName = 'iPod';
  else if (/android/.test(ua)) {
    const model = userAgent.match(/Android[^;]*;\s*([^;)]+?)(?:\s+Build\/[^;)]+)?[);]/i)?.[1]?.trim();
    deviceName = model || (isTablet ? 'Android tablet' : 'Android device');
  } else if (/macintosh|mac os x/.test(ua)) deviceName = 'Mac';
  else if (/windows/.test(ua)) deviceName = 'Windows PC';
  else if (/linux/.test(ua)) deviceName = 'Linux PC';

  let browser = 'Unknown';
  if (/edg\//i.test(userAgent)) browser = 'Microsoft Edge';
  else if (/opr\//i.test(userAgent)) browser = 'Opera';
  else if (/firefox|fxios/i.test(userAgent)) browser = 'Firefox';
  else if (/chrome|crios/i.test(userAgent)) browser = 'Chrome';
  else if (/safari/i.test(userAgent)) browser = 'Safari';
  else if (/msie|trident/i.test(userAgent)) browser = 'Internet Explorer';

  let operatingSystem = 'Unknown';
  if (/android/i.test(userAgent)) operatingSystem = 'Android';
  else if (/iphone|ipad|ipod/i.test(userAgent)) operatingSystem = 'iOS';
  else if (/windows/i.test(userAgent)) operatingSystem = 'Windows';
  else if (/macintosh|mac os x/i.test(userAgent)) operatingSystem = 'macOS';
  else if (/linux/i.test(userAgent)) operatingSystem = 'Linux';

  return { deviceName, deviceType, browser, operatingSystem };
}

export async function recordLoginActivity(userId, { ipAddress, userAgent } = {}) {
  const normalizedIp = normalizeIpAddress(ipAddress);
  let location = {};
  try {
    location = await lookupLocation(normalizedIp);
  } catch (error) {
    logger.warn('Login IP geolocation failed', { error: error.message });
  }

  await LoginHistory.create({
    userId,
    ipAddress: normalizedIp,
    ...location,
    ...parseDevice(userAgent),
    loginAt: new Date(),
  });
}

export async function listOwnLoginHistory(userId, { limit, cursor }) {
  const docs = await LoginHistory.find({
    userId,
    ...getAfterCursorFilter(cursor, 'loginAt'),
  })
    .sort(getPageSort('loginAt'))
    .limit(limit + 1)
    .select('ipAddress country state city deviceName deviceType browser operatingSystem loginAt')
    .lean();
  const page = buildPage(docs, limit, 'loginAt');

  return {
    items: page.items.map((entry) => ({
      id: entry._id,
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
