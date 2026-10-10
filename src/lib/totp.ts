import { authenticator } from 'otplib';
authenticator.options = { window: 1, step: 30, digits: 6 };

export const generateTotpSecret = () => authenticator.generateSecret();
export const totpUri = (accountEmail: string, secret: string, issuer = 'OMMIS') =>
  authenticator.keyuri(accountEmail, issuer, secret);
export const verifyTotp = (code: string, secret: string) => /^\d{6}$/.test(code) && authenticator.check(code, secret);
