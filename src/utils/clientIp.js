import { BlockList, isIP } from 'node:net';
import { logger } from './logger.js';

const nonPublicAddresses = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['2001:db8::', 32],
  ['2001::', 23],
]) {
  nonPublicAddresses.addSubnet(network, prefix, 'ipv6');
}
const globalIpv6Addresses = new BlockList();
globalIpv6Addresses.addSubnet('2000::', 3, 'ipv6');

function normalizeIpAddress(value) {
  if (typeof value !== 'string') return undefined;
  let candidate = value.trim();
  if (candidate.startsWith('[')) {
    const closingBracket = candidate.indexOf(']');
    if (closingBracket === -1 || (candidate.slice(closingBracket + 1) && !/^:\d+$/.test(candidate.slice(closingBracket + 1)))) {
      return undefined;
    }
    candidate = candidate.slice(1, closingBracket);
  }
  candidate = candidate.replace(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i, '$1');
  return isIP(candidate) ? candidate : undefined;
}

function isNonPublicIp(value) {
  const ipAddress = normalizeIpAddress(value);
  if (!ipAddress) return true;
  const version = isIP(ipAddress) === 4 ? 'ipv4' : 'ipv6';
  if (nonPublicAddresses.check(ipAddress, version)) return true;
  if (version === 'ipv6') return !globalIpv6Addresses.check(ipAddress, 'ipv6');
  return false;
}

function maskIpAddress(value) {
  const ipAddress = normalizeIpAddress(value);
  if (!ipAddress) return undefined;
  if (isIP(ipAddress) === 4) return `${ipAddress.split('.').slice(0, 3).join('.')}.0`;
  return `${ipAddress.split(':').slice(0, 3).join(':')}::`;
}

function forwardedAddresses(header) {
  if (typeof header !== 'string') return [];
  return header.split(',').map(normalizeIpAddress).filter(Boolean);
}

export function isPublicIpAddress(value) {
  return !isNonPublicIp(value);
}

export function resolveClientIp(req) {
  const expressIp = normalizeIpAddress(req.ip);
  const socketIp = normalizeIpAddress(req.socket?.remoteAddress);
  const trustedProxyHops = req.app?.get('trust proxy');
  const hasTrustedPrivateProxy =
    Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 && socketIp && isNonPublicIp(socketIp);

  const trustsProxy = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0;
  let selectedIp;
  let selectedFromForwardedChain = false;
  if (trustsProxy && hasTrustedPrivateProxy) {
    if (expressIp && !isNonPublicIp(expressIp)) {
      selectedIp = expressIp;
    } else {
      selectedIp = forwardedAddresses(req.headers?.['x-forwarded-for'])
        .reverse()
        .find((address) => !isNonPublicIp(address));
      selectedFromForwardedChain = Boolean(selectedIp);
    }
  } else if (trustsProxy) {
    selectedIp = socketIp;
  } else {
    selectedIp = expressIp ?? socketIp;
  }

  selectedIp ??= expressIp ?? socketIp;

  if (selectedFromForwardedChain || !selectedIp || isNonPublicIp(selectedIp)) {
    const forwarded = forwardedAddresses(req.headers?.['x-forwarded-for']);
    const xRealIp = normalizeIpAddress(req.headers?.['x-real-ip']);
    logger.warn(
      selectedFromForwardedChain
        ? 'Resolved login client IP from trusted forwarded chain'
        : 'Login request has no verified public client IP',
      {
        expressIp: maskIpAddress(expressIp),
        socketIp: maskIpAddress(socketIp),
        forwardedFor: forwarded.slice(0, 8).map(maskIpAddress),
        xRealIp: maskIpAddress(xRealIp),
        trustProxy: Number.isInteger(trustedProxyHops) ? trustedProxyHops : 0,
        selectedIp: maskIpAddress(selectedIp),
      },
    );
  }

  return selectedIp;
}
