import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Check } from 'lucide-react';
import './Login.css';

const otpLength = 4;

export default function Login({
  error,
  verificationError,
  browserRequest,
  onStartBrowserLogin,
  onVerifyBrowserOtp,
  stayLoggedIn,
  onStayLoggedInChange,
}) {
  const [otp, setOtp] = useState('');
  const [successOffsets, setSuccessOffsets] = useState(() => Array(otpLength).fill(0));
  const inputRef = useRef(null);
  const slotsRef = useRef(null);
  const slotRefs = useRef([]);
  const submittedOtp = useRef('');
  const reduceMotion = useReducedMotion();
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

  useLayoutEffect(() => {
    if (!pending || success) return undefined;

    const measureSlots = () => {
      const slots = slotsRef.current;
      if (!slots || slotRefs.current.length !== otpLength) return;
      const slotsRect = slots.getBoundingClientRect();
      const center = slotsRect.left + slotsRect.width / 2;
      const nextOffsets = slotRefs.current.map((slot) => {
        if (!slot) return 0;
        const slotRect = slot.getBoundingClientRect();
        return center - (slotRect.left + slotRect.width / 2);
      });
      setSuccessOffsets((current) => nextOffsets.every((offset, index) => (
        Math.abs(offset - current[index]) < 0.5
      )) ? current : nextOffsets);
    };

    const frame = window.requestAnimationFrame(measureSlots);
    const observer = typeof ResizeObserver === 'function'
      ? new ResizeObserver(measureSlots)
      : null;
    if (observer && slotsRef.current) observer.observe(slotsRef.current);
    window.addEventListener('resize', measureSlots);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', measureSlots);
    };
  }, [pending, success]);

  useEffect(() => {
    if (!pending || verifying || success) return undefined;

    const handleImmediateInput = (event) => {
      if (event.defaultPrevented || event.isComposing || event.altKey
        || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const input = inputRef.current;
      if (!input || document.activeElement === input) return;
      const activeElement = document.activeElement;
      if (activeElement?.matches('input, textarea, select, button, a[href]')
        || activeElement?.isContentEditable) return;

      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        input.focus();
        setOtp((current) => `${current}${event.key}`.slice(0, otpLength));
      } else if (event.key === 'Backspace') {
        event.preventDefault();
        input.focus();
        setOtp((current) => current.slice(0, -1));
      }
    };

    window.addEventListener('keydown', handleImmediateInput);
    return () => window.removeEventListener('keydown', handleImmediateInput);
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
                <label className="login-remember">
                  <input type="checkbox" checked={stayLoggedIn} disabled={creating}
                    onChange={(event) => onStayLoggedInChange(event.target.checked)} />
                  <span>Stay logged in</span>
                </label>
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
                      autoFocus
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
                    <motion.span ref={slotsRef} className="otp-slots" aria-hidden="true">
                      {Array.from({ length: otpLength }, (_, index) => {
                        const digit = otp[index] || '';
                        const active = !verifying && !success && Math.min(otp.length, otpLength - 1) === index;
                        return (
                          <motion.span
                            ref={(node) => { slotRefs.current[index] = node; }}
                            className={`otp-slot${digit ? ' has-value' : ''}${active ? ' is-active' : ''}`}
                            key={index}
                            animate={success
                              ? {
                                  x: reduceMotion ? 0 : successOffsets[index],
                                  scale: reduceMotion ? 0.82 : 0.14,
                                  opacity: 0,
                                }
                              : { x: 0, scale: 1, opacity: verifying ? 0.55 : 1 }}
                            transition={reduceMotion ? { duration: 0 } : success ? {
                              x: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
                              scale: { duration: 0.52, ease: [0.22, 1, 0.36, 1] },
                              opacity: { duration: 0.16, delay: 0.38 },
                            } : { duration: 0.16 }}
                          >
                            <span className="otp-digit">{digit}</span>
                          </motion.span>
                        );
                      })}
                    </motion.span>
                    <AnimatePresence>
                      {verifying && (
                        <motion.span
                          className="otp-verification-sweep"
                          aria-hidden="true"
                          initial={reduceMotion ? false : { x: '-100%' }}
                          animate={reduceMotion ? { x: '200%' } : { x: ['-100%', '400%'] }}
                          exit={{ opacity: 0 }}
                          transition={reduceMotion ? { duration: 0 } : {
                            duration: 0.88,
                            ease: [0.65, 0, 0.35, 1],
                            repeat: Infinity,
                          }}
                        />
                      )}
                    </AnimatePresence>
                    <AnimatePresence>
                      {success && (
                        <motion.span
                          className="otp-success-mark"
                          aria-hidden="true"
                          initial={reduceMotion ? false : { opacity: 0, scale: 0.55, rotate: -16 }}
                          animate={reduceMotion ? { opacity: 1 } : {
                            opacity: 1,
                            scale: [0.55, 1.12, 1],
                            rotate: [-16, 4, 0],
                          }}
                          exit={{ opacity: 0, scale: 0.88 }}
                          transition={reduceMotion ? { duration: 0 } : {
                            delay: 0.5,
                            duration: 0.4,
                            ease: [0.22, 1, 0.36, 1],
                          }}
                        >
                          <Check />
                        </motion.span>
                      )}
                    </AnimatePresence>
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
