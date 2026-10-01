import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check } from 'lucide-react';
import './Login.css';

const otpLength = 4;

export default function Login({
  error,
  verificationError,
  browserRequest,
  onStartBrowserLogin,
  onVerifyBrowserOtp,
}) {
  const [otp, setOtp] = useState('');
  const inputRef = useRef(null);
  const submittedOtp = useRef('');
  const creating = browserRequest?.status === 'creating';
  const pending = browserRequest && !creating;
  const verifying = browserRequest?.status === 'verifying';
  const success = browserRequest?.status === 'success';

  const submitOtp = useCallback((value) => {
    if (!/^\d{4}$/.test(value) || verifying || success || submittedOtp.current === value) return;
    submittedOtp.current = value;
    onVerifyBrowserOtp(value).catch(() => {
      submittedOtp.current = '';
    });
  }, [onVerifyBrowserOtp, success, verifying]);

  useEffect(() => {
    if (!pending || verifying || success) return undefined;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [pending, success, verifying]);

  useEffect(() => {
    if (!verificationError) return undefined;
    submittedOtp.current = '';
    const frame = window.requestAnimationFrame(() => {
      setOtp('');
      inputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [verificationError]);

  useEffect(() => {
    if (otp.length !== otpLength || verifying || success || submittedOtp.current === otp) return undefined;
    const timer = window.setTimeout(() => submitOtp(otp), 180);
    return () => window.clearTimeout(timer);
  }, [otp, submitOtp, success, verifying]);

  const handleOtpChange = (event) => {
    const nextOtp = event.target.value.replace(/\D/g, '').slice(0, otpLength);
    if (nextOtp.length < otpLength) submittedOtp.current = '';
    setOtp(nextOtp);
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    submitOtp(otp);
  };

  const handleRequestCode = () => {
    submittedOtp.current = '';
    setOtp('');
    onStartBrowserLogin().catch(() => undefined);
  };

  return (
    <main className={`login-shell${pending ? ' is-pending' : ''}`}>
      <header className="login-header">
        <span className="login-wordmark" translate="no">AkadilEDU</span>
      </header>

      <div className="login-composition">
        <section className="login-intro" aria-labelledby="login-title">
          <h1 id="login-title">
            {pending ? <>Check<br />Telegram.</> : <>Secure<br />access.</>}
          </h1>
        </section>

        <section className="login-action" aria-labelledby="login-action-title">
          <div className="login-action-content">
            {error && (
              <div className="login-error" role="alert" aria-live="assertive">
                {error}
              </div>
            )}

            {!pending ? (
              <>
                <h2 id="login-action-title">Sign In</h2>
                <p className="login-description">Receive a 4-digit code in Telegram.</p>
                <button
                  type="button"
                  disabled={creating}
                  aria-busy={creating}
                  onClick={handleRequestCode}
                  className="login-request"
                >
                  <span>{creating ? 'Requesting…' : 'Get Code'}</span>
                  <ArrowRight aria-hidden="true" />
                </button>
              </>
            ) : (
              <>
                <h2 id="login-action-title">Enter the Code</h2>
                <p className="login-description">Sent by <span translate="no">@akadiledu_bot</span></p>

                <form className="otp-form" onSubmit={handleSubmit}>
                  <label
                    className={`otp-field${verificationError ? ' is-invalid' : ''}${verifying ? ' is-verifying' : ''}${success ? ' is-success' : ''}`}
                  >
                    <span className="otp-visually-hidden">Telegram login code, 4 digits</span>
                    <input
                      ref={inputRef}
                      className="otp-native-input"
                      name="otp"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      pattern="[0-9]*"
                      maxLength={otpLength}
                      spellCheck={false}
                      value={otp}
                      disabled={verifying || success}
                      aria-invalid={verificationError ? 'true' : 'false'}
                      aria-describedby={verificationError ? 'otp-error' : 'otp-status'}
                      onChange={handleOtpChange}
                    />
                    <span className="otp-slots" aria-hidden="true">
                      {Array.from({ length: otpLength }, (_, index) => {
                        const digit = otp[index] || '';
                        const active = !verifying && !success && Math.min(otp.length, otpLength - 1) === index;
                        return (
                          <span
                            className={`otp-slot${digit ? ' has-value' : ''}${active ? ' is-active' : ''}`}
                            style={{ '--otp-index': index }}
                            key={index}
                          >
                            <span className="otp-digit">{digit}</span>
                          </span>
                        );
                      })}
                    </span>
                    {success && (
                      <span className="otp-success-mark" aria-hidden="true">
                        <Check />
                      </span>
                    )}
                  </label>

                  <div className="otp-feedback" aria-live="polite">
                    {verificationError ? (
                      <span id="otp-error" className="otp-error" role="alert">{verificationError}</span>
                    ) : (
                      <span id="otp-status">{verifying ? 'Checking Code' : success ? 'Code Verified' : ''}</span>
                    )}
                  </div>
                </form>

                <div className="login-links">
                  <a href={browserRequest.botUrl} target="_blank" rel="noopener noreferrer">
                    <span>Open Telegram</span>
                    <ArrowRight aria-hidden="true" />
                  </a>
                  <button type="button" disabled={verifying || success} onClick={handleRequestCode}>
                    Request Another Code
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
