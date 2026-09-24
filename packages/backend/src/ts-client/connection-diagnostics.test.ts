import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TeamSpeakFloodError, TSApiError } from '../middleware/error-handler.js';
import {
  assertReportHasNoSecrets,
  classifyDiagnosticError,
  diagnoseConnection,
  finalizeReport,
  sanitizeVersionString,
  summarizeDiagnosticToast,
  type DiagnosticWebQueryClient,
} from './connection-diagnostics.js';

const SECRET_KEY = 'super-secret-apikey-value-xyz';

function mockClient(handlers: Record<string, () => Promise<unknown>>): DiagnosticWebQueryClient {
  return {
    async execute(_sid, command) {
      const handler = handlers[command];
      if (!handler) throw new TSApiError(-1, `unexpected command ${command}`);
      return handler();
    },
  };
}

describe('classifyDiagnosticError', () => {
  it('maps invalid apikey to auth', () => {
    const result = classifyDiagnosticError(new TSApiError(512, 'invalid apikey'));
    assert.equal(result.kind, 'auth');
    assert.equal(result.code, 'invalid_apikey');
    assert.ok(!result.message.toLowerCase().includes(SECRET_KEY));
  });

  it('maps permission denied', () => {
    const result = classifyDiagnosticError(new TSApiError(2568, 'insufficient client permissions'));
    assert.equal(result.kind, 'permission');
    assert.equal(result.code, 'permission_denied');
  });

  it('maps flood without suggesting retries', () => {
    const result = classifyDiagnosticError(new TeamSpeakFloodError(45));
    assert.equal(result.kind, 'flood');
    assert.equal(result.code, 'flood');
    assert.match(result.message, /45/);
  });

  it('maps timeout', () => {
    const err = new Error('timeout of 15000ms exceeded');
    err.name = 'TimeoutError';
    const result = classifyDiagnosticError(err);
    assert.equal(result.kind, 'timeout');
    assert.equal(result.code, 'timeout');
  });
});

describe('sanitizeVersionString', () => {
  it('formats version arrays and drops secret-looking strings', () => {
    assert.equal(
      sanitizeVersionString([{ version: '6.0.0-beta13', platform: 'Linux', build: '1' }]),
      '6.0.0-beta13 Linux 1',
    );
    assert.equal(sanitizeVersionString([{ version: `leak ${SECRET_KEY}` }]), undefined);
  });
});

describe('diagnoseConnection', () => {
  it('returns full success when all probes pass', async () => {
    const report = await diagnoseConnection(mockClient({
      version: async () => [{ version: '6.0.0', platform: 'Linux' }],
      whoami: async () => [{ client_nickname: 'serveradmin' }],
      serverlist: async () => [{ virtualserver_id: '1' }],
      serverinfo: async () => [{ virtualserver_name: 'Main' }],
    }));

    assert.equal(report.success, true);
    assert.equal(report.partial, false);
    assert.equal(report.overall, 'ok');
    assert.equal(report.stages.length, 4);
    assert.ok(report.stages.every((s) => s.status === 'ok'));
    assert.ok(report.version?.includes('6.0.0'));
    assertReportHasNoSecrets(report, [SECRET_KEY]);
  });

  it('treats invalid key on version as reachable but auth failed', async () => {
    const report = await diagnoseConnection(mockClient({
      version: async () => {
        throw new TSApiError(512, `invalid apikey for ${SECRET_KEY}`);
      },
    }));

    assert.equal(report.success, false);
    assert.equal(report.partial, true);
    assert.equal(report.overall, 'partial');
    assert.equal(report.stages[0].id, 'reachability');
    assert.equal(report.stages[0].status, 'ok');
    assert.equal(report.stages[1].id, 'authentication');
    assert.equal(report.stages[1].status, 'fail');
    assert.equal(report.stages[1].code, 'invalid_apikey');
    assert.equal(report.stages[2].status, 'skipped');
    assert.equal(report.stages[3].status, 'skipped');
    assert.ok(!JSON.stringify(report).includes(SECRET_KEY));
    assertReportHasNoSecrets(report, [SECRET_KEY]);
  });

  it('marks permission denied on serverlist and skips virtual server', async () => {
    const report = await diagnoseConnection(mockClient({
      version: async () => [{ version: '6.0.0' }],
      whoami: async () => [{ client_id: '1' }],
      serverlist: async () => {
        throw new TSApiError(2568, 'insufficient client permissions');
      },
    }));

    assert.equal(report.success, false);
    assert.equal(report.partial, true);
    assert.equal(report.stages[2].id, 'permissions');
    assert.equal(report.stages[2].status, 'fail');
    assert.equal(report.stages[2].code, 'permission_denied');
    assert.equal(report.stages[3].status, 'skipped');
  });

  it('keeps network failures on permissions as unreachable, not permission_denied', async () => {
    const err = new Error('connect ECONNREFUSED');
    (err as { code?: string }).code = 'ECONNREFUSED';
    const report = await diagnoseConnection(mockClient({
      version: async () => [{ version: '6.0.0' }],
      whoami: async () => [{ client_id: '1' }],
      serverlist: async () => {
        throw err;
      },
    }));

    assert.equal(report.stages[2].status, 'fail');
    assert.equal(report.stages[2].code, 'unreachable');
    assert.equal(report.stages[3].status, 'skipped');
  });

  it('returns flood on the failing stage without retrying commands', async () => {
    let calls = 0;
    const report = await diagnoseConnection(mockClient({
      version: async () => {
        calls += 1;
        throw new TeamSpeakFloodError(60);
      },
      whoami: async () => {
        calls += 1;
        return [];
      },
    }));

    assert.equal(calls, 1);
    assert.equal(report.stages[0].code, 'flood');
    assert.equal(report.stages[0].status, 'fail');
    assert.ok(report.stages.slice(1).every((s) => s.status === 'skipped'));
    assert.equal(report.success, false);
  });

  it('fails reachability on timeout and skips the rest', async () => {
    const err = new Error('timeout of 15000ms exceeded');
    (err as { code?: string }).code = 'ECONNABORTED';
    const report = await diagnoseConnection(mockClient({
      version: async () => {
        throw err;
      },
    }));

    assert.equal(report.stages[0].status, 'fail');
    assert.equal(report.stages[0].code, 'timeout');
    assert.ok(report.stages.slice(1).every((s) => s.status === 'skipped'));
    assert.equal(report.partial, false);
    assert.equal(report.overall, 'fail');
  });

  it('guest/version alone is not complete admin success', async () => {
    const report = await diagnoseConnection(mockClient({
      version: async () => [{ version: '6.0.0-guest' }],
      whoami: async () => {
        throw new TSApiError(512, 'invalid apikey');
      },
    }));

    assert.equal(report.stages[0].status, 'ok');
    assert.equal(report.success, false);
    assert.notEqual(report.overall, 'ok');
  });

  it('marks virtual server inaccessible after earlier stages pass', async () => {
    const report = await diagnoseConnection(mockClient({
      version: async () => [{ version: '6.0.0' }],
      whoami: async () => [{ client_id: '1' }],
      serverlist: async () => [{ virtualserver_id: '1' }],
      serverinfo: async () => {
        throw new TSApiError(2568, 'insufficient client permissions');
      },
    }));

    assert.equal(report.partial, true);
    assert.equal(report.stages[3].status, 'fail');
    assert.equal(report.stages[3].code, 'virtual_server_inaccessible');
  });
});

describe('finalizeReport', () => {
  it('computes overall flags from stage statuses', () => {
    const partial = finalizeReport([
      { id: 'reachability', status: 'ok', message: 'ok' },
      { id: 'authentication', status: 'fail', message: 'no', code: 'invalid_apikey' },
      { id: 'permissions', status: 'skipped', message: 'skip', code: 'skipped' },
      { id: 'virtual_server', status: 'skipped', message: 'skip', code: 'skipped' },
    ]);
    assert.equal(partial.success, false);
    assert.equal(partial.partial, true);
    assert.equal(partial.overall, 'partial');
  });
});

describe('summarizeDiagnosticToast', () => {
  it('success copy confirms read stages without claiming write authorization', () => {
    const toast = summarizeDiagnosticToast({
      success: true,
      partial: false,
      overall: 'ok',
      stages: [],
      version: '6.0.0-beta13',
    });
    assert.match(toast, /read stages OK/i);
    assert.match(toast, /write actions still need/i);
    assert.doesNotMatch(toast, /full admin/i);
  });
});
