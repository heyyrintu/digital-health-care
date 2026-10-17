import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config';
import { RedisQueueProbe, queuesNotConfigured } from './queue-health';

const servers: Server[] = [];
const sockets: Socket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  await Promise.all(servers.splice(0).map((s) => new Promise((done) => s.close(done))));
});

/** A port that takes connections and never answers, like a Redis that has hung. */
async function silentPort(): Promise<number> {
  const server = createServer((socket) => void sockets.push(socket));
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return (server.address() as { port: number }).port;
}

/** A port nothing listens on: connections are refused at once. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as { port: number };
  await new Promise((done) => server.close(done));
  return port;
}

describe('queue health', () => {
  it('is not configured without REDIS_URL', async () => {
    expect(loadConfig({}).REDIS_URL).toBeUndefined();
    expect(loadConfig({ REDIS_URL: '' }).REDIS_URL).toBeUndefined();
    expect(() => loadConfig({ REDIS_URL: 'not a url' })).toThrow();
    await expect(queuesNotConfigured.check()).resolves.toEqual({
      status: 'not_configured',
      items: [],
    });
  });

  it('is down, without throwing, when Redis refuses the connection', async () => {
    const probe = new RedisQueueProbe(`redis://127.0.0.1:${await closedPort()}`);
    await expect(probe.check()).resolves.toEqual({ status: 'down', items: [] });
    await probe.close();
  });

  it('is down within its time limit when Redis does not answer', async () => {
    const probe = new RedisQueueProbe(`redis://127.0.0.1:${await silentPort()}`, 200);
    const started = Date.now();
    await expect(probe.check()).resolves.toEqual({ status: 'down', items: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
    await probe.close();
  });

  it('closes a check still running when the app closes', async () => {
    const probe = new RedisQueueProbe(`redis://127.0.0.1:${await silentPort()}`, 5_000);
    const check = probe.check();
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await probe.close();
    await expect(check).resolves.toEqual({ status: 'down', items: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});
