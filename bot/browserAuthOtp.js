const { createHmac, randomInt, timingSafeEqual } = require('node:crypto');

const requestIdPattern = /^[a-f0-9]{48}$/;
const challengePattern = /^[a-f0-9]{64}$/;
const otpPattern = /^\d{4}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function otpPepper() {
  const value = process.env.BROWSER_AUTH_OTP_PEPPER;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('BROWSER_AUTH_OTP_PEPPER must contain at least 32 bytes.');
  }
  return value;
}

function validateOtpInput(requestId, challenge, otp) {
  if (!requestIdPattern.test(requestId) || !challengePattern.test(challenge) || !otpPattern.test(otp)) {
    throw new Error('Invalid browser OTP input.');
  }
}

function generateBrowserOtp() {
  return String(randomInt(10_000)).padStart(4, '0');
}

function digestBrowserOtp(requestId, challenge, otp) {
  validateOtpInput(requestId, challenge, otp);
  return createHmac('sha256', otpPepper())
    .update(`${requestId}.${challenge}.${otp}`)
    .digest('hex');
}

function matchesBrowserOtp(expectedDigest, requestId, challenge, otp) {
  if (!digestPattern.test(String(expectedDigest || ''))) return false;
  const actualDigest = digestBrowserOtp(requestId, challenge, otp);
  return timingSafeEqual(Buffer.from(expectedDigest, 'hex'), Buffer.from(actualDigest, 'hex'));
}

module.exports = { generateBrowserOtp, digestBrowserOtp, matchesBrowserOtp };
