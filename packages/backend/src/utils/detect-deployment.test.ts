import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inferDeploymentScenario, type DeploymentProbeResult } from './detect-deployment.js';

function probe(host: string, reachable: boolean, dnsResolved = true): DeploymentProbeResult {
  return { host, port: 10080, reachable, dnsResolved };
}

describe('inferDeploymentScenario', () => {
  it('suggests same-host when localhost is reachable on bare metal', () => {
    const result = inferDeploymentScenario(false, [probe('127.0.0.1', true), probe('teamspeak', false, false)]);
    assert.equal(result.suggestedScenarioId, 'same-host');
    assert.equal(result.suggestedHost, '127.0.0.1');
    assert.equal(result.confidence, 'high');
  });

  it('suggests both-docker when teamspeak is reachable from a container', () => {
    const result = inferDeploymentScenario(true, [
      probe('127.0.0.1', false),
      probe('teamspeak', true),
      probe('host.docker.internal', false),
    ]);
    assert.equal(result.suggestedScenarioId, 'both-docker');
    assert.equal(result.suggestedHost, 'teamspeak');
    assert.equal(result.confidence, 'high');
  });

  it('suggests host.docker.internal when manager is in Docker and TS is on the host', () => {
    const result = inferDeploymentScenario(true, [
      probe('127.0.0.1', false),
      probe('teamspeak', false, false),
      probe('host.docker.internal', true),
    ]);
    assert.equal(result.suggestedScenarioId, null);
    assert.equal(result.suggestedHost, 'host.docker.internal');
  });

  it('suggests remote TS when nothing local is reachable from Docker', () => {
    const result = inferDeploymentScenario(true, [
      probe('127.0.0.1', false),
      probe('teamspeak', false, false),
      probe('host.docker.internal', false),
    ]);
    assert.equal(result.suggestedScenarioId, 'manager-docker-remote-ts');
    assert.equal(result.confidence, 'medium');
  });

  it('suggests remote TS on bare metal when no local probes succeed', () => {
    const result = inferDeploymentScenario(false, [
      probe('127.0.0.1', false),
      probe('teamspeak', false, false),
    ]);
    assert.equal(result.suggestedScenarioId, 'remote-ts');
  });
});
