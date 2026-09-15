import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateTravelMinutes, haversineDistanceKm } from './travel';

describe('planning travel', () => {
  beforeEach(() => {
    vi.stubEnv('ROUTING_ENABLED', 'true');
    vi.stubEnv('ROUTING_API_BASE_URL', 'https://osrm.example.test');
  });

  it('parses an OSRM-compatible route response', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ routes: [{ duration: 1800, distance: 12000 }] }), { status: 200 }));
    const result = await estimateTravelMinutes({ lat: 48.85, lon: 2.35 }, { lat: 48.9, lon: 2.4 }, {
      fetchImpl,
      baseUrl: 'https://osrm.example.test',
    });
    expect(result).toMatchObject({ status: 'ok', minutes: 30, source: 'osrm' });
  });

  it('degrades to unavailable instead of inventing a route', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('network down'); });
    const result = await estimateTravelMinutes({ lat: 48.85, lon: 2.35 }, { lat: 48.9, lon: 2.4 }, {
      fetchImpl,
      baseUrl: 'https://osrm.example.test',
    });
    expect(result.status).toBe('unavailable');
  });

  it('does not call a public OSRM fallback when routing is disabled', async () => {
    vi.stubEnv('ROUTING_ENABLED', 'false');
    delete process.env.ROUTING_API_BASE_URL;
    const fetchImpl = vi.fn(async () => new Response('should-not-run'));
    const result = await estimateTravelMinutes({ lat: 48.85, lon: 2.35 }, { lat: 48.9, lon: 2.4 }, { fetchImpl });
    expect(result.status).toBe('unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('computes a sane straight-line distance for diagnostics', () => {
    const distance = haversineDistanceKm({ lat: 48.8566, lon: 2.3522 }, { lat: 48.8666, lon: 2.3522 });
    expect(distance).toBeGreaterThan(1);
    expect(distance).toBeLessThan(2);
  });
});
