import { ArrowUpRight, X } from 'lucide-react';
import './Login.css';

export default function Login({ error, browserRequest, onStartBrowserLogin, onCancelBrowserLogin }) {
  const creating = browserRequest?.status === 'creating';
  const pending = browserRequest?.status === 'pending';

  return (
    <main className={`login-shell${pending ? ' is-pending' : ''}`}>
      <header className="login-header">
        <span className="login-wordmark" translate="no">AkadilEDU</span>
        <div className="login-header-meta" aria-label="Sign-in context">
          <span>Admin access</span>
          <span>Session-only sign in</span>
        </div>
      </header>

      <div className="login-composition">
        <section className="login-intro" aria-labelledby="login-title">
          <div>
            <p className="login-label">Browser sign in</p>
            <h1 id="login-title">
              {pending ? (
                <>Match the code.<br />Approve access.</>
              ) : (
                <>Admin access,<br />approved by you.</>
              )}
            </h1>
            <p className="login-intro-copy">
              {pending
                ? 'Your browser stays locked until you approve this exact request in Telegram.'
                : 'Use your existing Telegram identity. No separate password, no credentials to remember.'}
            </p>
          </div>
        </section>

        <section className="login-action" aria-labelledby="login-action-title">
          <div className="login-action-content" key={pending ? 'pending' : 'ready'}>
            {error && (
              <div className="login-error" role="alert" aria-live="assertive">
                <strong>Unable to sign in</strong>
                <span>{error}</span>
              </div>
            )}

            {!pending ? (
              <>
                <p className="login-step">Telegram verification</p>
                <h2 id="login-action-title">Continue from your phone.</h2>
                <p className="login-description">
                  We will send a one-time approval request to the AkadilEDU bot. Only an authorized administrator can approve it.
                </p>
                <button
                  type="button"
                  disabled={creating}
                  aria-busy={creating}
                  data-loading={creating ? 'true' : 'false'}
                  onClick={onStartBrowserLogin}
                  className="login-primary"
                >
                  <span>{creating ? 'Preparing secure request…' : 'Continue with Telegram'}</span>
                  <ArrowUpRight aria-hidden="true" />
                </button>
                <p className="login-assurance">The request expires automatically and can be used only once.</p>
              </>
            ) : (
              <>
                <p className="login-step">Telegram verification</p>
                <h2 id="login-action-title">Confirm this code.</h2>
                <p className="login-description">
                  Open the bot and approve the request only if the same code appears there.
                </p>
                <output className="login-code" aria-label={`Matching code ${browserRequest.displayCode}`} translate="no">
                  {browserRequest.displayCode}
                </output>
                <a
                  href={browserRequest.botUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="login-primary"
                >
                  <span>Open approval in Telegram</span>
                  <ArrowUpRight aria-hidden="true" />
                </a>
                <div className="login-status" role="status" aria-live="polite">
                  <span>Status</span>
                  <strong>Waiting for your approval</strong>
                </div>
                <button type="button" onClick={onCancelBrowserLogin} className="login-cancel">
                  <span>Cancel request</span>
                  <X aria-hidden="true" />
                </button>
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="login-footer">
        <span>Private by design. No password stored.</span>
        <span>Browser access ends when this session closes.</span>
      </footer>
    </main>
  );
}
