import { AlertCircle, KeyRound, LoaderCircle, Send, ShieldCheck, X } from 'lucide-react';

export default function Login({ error, browserRequest, onStartBrowserLogin, onCancelBrowserLogin }) {
  const creating = browserRequest?.status === 'creating';
  const pending = browserRequest?.status === 'pending';

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-4">
      <div className="w-full max-w-md">
        {error && (
          <div className="mb-4 flex items-center gap-3 rounded-xl border border-red-400/30 bg-red-500/10 p-4 text-red-100">
            <AlertCircle className="h-5 w-5 flex-shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/[0.07] shadow-2xl shadow-blue-950/40 backdrop-blur-xl">
          <div className="border-b border-white/10 px-8 py-7 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-blue-500/15 ring-1 ring-blue-300/30">
              <ShieldCheck className="h-7 w-7 text-blue-300" />
            </div>
            <h1 className="text-2xl font-semibold text-white">AkadilEDU Admin</h1>
            <p className="mt-2 text-sm leading-6 text-slate-300">
              Secure browser access approved from your Telegram account.
            </p>
          </div>

          <div className="p-8">
            {!pending ? (
              <>
                <div className="mb-6 flex gap-3 rounded-2xl bg-slate-950/35 p-4">
                  <KeyRound className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-300" />
                  <p className="text-sm leading-6 text-slate-300">
                    Request access here, compare the code, and approve the knock in the bot. No password is stored.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={creating}
                  onClick={onStartBrowserLogin}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-3.5 font-medium text-white transition hover:bg-blue-400 disabled:cursor-wait disabled:opacity-70"
                >
                  {creating ? <LoaderCircle className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
                  {creating ? 'Creating secure request…' : 'Knock through Telegram'}
                </button>
              </>
            ) : (
              <div className="text-center">
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-blue-300">Your matching code</p>
                <div className="my-5 rounded-2xl border border-blue-300/20 bg-slate-950/45 px-6 py-5 font-mono text-4xl font-semibold tracking-[0.22em] text-white">
                  {browserRequest.displayCode}
                </div>
                <p className="mb-5 text-sm leading-6 text-slate-300">
                  Open the bot, make sure it shows the same code, then tap <span className="font-medium text-white">Approve sign-in</span>.
                </p>
                <a
                  href={browserRequest.botUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-blue-500 px-5 py-3.5 font-medium text-white transition hover:bg-blue-400"
                >
                  <Send className="h-5 w-5" />
                  Open approval in Telegram
                </a>
                <div className="mt-4 flex items-center justify-center gap-2 text-sm text-slate-400">
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  Waiting for your approval
                </div>
                <button
                  type="button"
                  onClick={onCancelBrowserLogin}
                  className="mx-auto mt-5 flex items-center gap-1.5 text-sm text-slate-400 transition hover:text-white"
                >
                  <X className="h-4 w-4" />
                  Cancel request
                </button>
              </div>
            )}
          </div>
        </div>

        <p className="mt-4 text-center text-xs text-slate-500">
          Browser access lasts for this browser session only.
        </p>
      </div>
    </div>
  );
}
