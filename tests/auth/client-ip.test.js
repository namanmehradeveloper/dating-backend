import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/utils/logger.js';
import { isPublicIpAddress, resolveClientIp } from '../../src/utils/clientIp.js';

function request({ ip, remoteAddress, forwardedFor, realIp, trustProxy = 1 }) {
  return {
    ip,
    socket: { remoteAddress },
    headers: {
      'x-forwarded-for': forwardedFor,
      'x-real-ip': realIp,
    },
    app: { get: () => trustProxy },
  };
}

describe('Render client IP resolution', () => {
  it('skips private Render proxy hops and selects the nearest public forwarded address', () => {
    const req = request({
      ip: '10.31.99.80',
      remoteAddress: '10.31.99.81',
      forwardedFor: '203.0.113.9, 8.8.8.8, 10.31.99.80',
      realIp: '1.1.1.1',
    });
    expect(resolveClientIp(req)).toBe('8.8.8.8');
  });

  it('ignores forwarding headers when the socket is not a trusted private proxy', () => {
    const req = request({
      ip: '8.8.4.4',
      remoteAddress: '8.8.4.4',
      forwardedFor: '8.8.8.8',
      realIp: '1.1.1.1',
    });
    expect(resolveClientIp(req)).toBe('8.8.4.4');
  });

  it('ignores x-real-ip and never substitutes it for a private socket address', () => {
    const req = request({
      ip: '10.31.99.80',
      remoteAddress: '10.31.99.81',
      realIp: '8.8.8.8',
    });
    expect(resolveClientIp(req)).toBe('10.31.99.80');
  });

  it('masks addresses in proxy diagnostic logs', () => {
    const warn = vi.spyOn(logger, 'warn');
    const req = request({
      ip: '10.31.99.80',
      remoteAddress: '10.31.99.81',
      forwardedFor: '10.31.99.80',
      realIp: '10.31.99.82',
    });

    resolveClientIp(req);

    expect(warn).toHaveBeenCalledWith(
      'Login request has no verified public client IP',
      expect.objectContaining({
        expressIp: '10.31.99.0',
        socketIp: '10.31.99.0',
        forwardedFor: ['10.31.99.0'],
        xRealIp: '10.31.99.0',
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('10.31.99.80');
    warn.mockRestore();
  });

  it('resolves public IPv6 after a private IPv6 proxy hop', () => {
    const req = request({
      ip: 'fd00::2',
      remoteAddress: 'fd00::3',
      forwardedFor: '2001:4860:4860::8888, fd00::2',
    });
    expect(resolveClientIp(req)).toBe('2001:4860:4860::8888');
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true);
    expect(isPublicIpAddress('fd00::1')).toBe(false);
  });

  it.each(['10.31.99.80', '127.0.0.1', '192.0.2.1', '2001:db8::1', '::1'])(
    'does not classify %s as public',
    (ipAddress) => expect(isPublicIpAddress(ipAddress)).toBe(false),
  );
});
