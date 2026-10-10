import { decrypt, encrypt, sha256 } from '../../src/lib/crypto';
import { assertPasswordPolicy } from '../../src/lib/password';
import { renderString } from '../../src/modules/notifications/template';
import { sanitize } from '../../src/modules/audit/audit.service';
import { formatIndian } from '../../src/shared/format';

describe('misc libraries', () => {
  it('AES-GCM round trip and tamper detection', () => {
    const c = encrypt('JBSWY3DPEHPK3PXP');
    expect(decrypt(c)).toBe('JBSWY3DPEHPK3PXP');
    const parts = c.split('.');
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decrypt(parts.join('.'))).toThrow();
    expect(sha256('a')).toHaveLength(64);
  });
  it('password policy', () => {
    expect(() => assertPasswordPolicy('short1')).toThrow();
    expect(() => assertPasswordPolicy('longpassword')).toThrow();
    expect(() => assertPasswordPolicy('longpassw0rd')).not.toThrow();
  });
  it('templates escape HTML only in HTML bodies', () => {
    expect(renderString('Hi {{name}}', { name: '<b>' }, true)).toBe('Hi &lt;b&gt;');
    expect(renderString('Hi {{name}}', { name: '<b>' }, false)).toBe('Hi <b>');
  });
  it('audit sanitize removes secrets at any depth', () => {
    expect(sanitize({ a: 1, password_hash: 'x', nested: { totpSecret: 'y', ok: true } })).toEqual({ a: 1, nested: { ok: true } });
  });
  it('Indian number format', () => {
    expect(formatIndian(13046190)).toBe('1,30,46,190');
    expect(formatIndian('679206.18', 2)).toBe('6,79,206.18');
  });
});
