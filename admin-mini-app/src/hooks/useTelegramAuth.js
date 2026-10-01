import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browserSessionPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, get, ref } from '../lib/firebase';

function validVerifiedUser(user) {
  return user && Number.isSafeInteger(user.id) && user.id > 0;
}

async function loadAdminProfile(firebaseUser, verifiedUser = null) {
  if (!/^\d{1,16}$/.test(firebaseUser.uid)) {
    throw new Error('Invalid authenticated identity.');
  }
  const id = Number(firebaseUser.uid);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error('Invalid authenticated identity.');
  }

  const [adminSnapshot, profileSnapshot] = await Promise.all([
    get(ref(db, `admins/${firebaseUser.uid}`)),
    get(ref(db, `users/${firebaseUser.uid}`)),
  ]);
  if (!adminSnapshot.exists()) {
    throw new Error('Administrator access has been revoked.');
  }
  const profile = profileSnapshot.val() || {};
  return {
    id,
    firstName: verifiedUser?.firstName || profile.firstName || '',
    lastName: verifiedUser?.lastName || profile.lastName || '',
    username: verifiedUser?.username || profile.username || '',
    languageCode: verifiedUser?.languageCode || profile.language || '',
    role: adminSnapshot.val().role,
    isAdmin: true,
  };
}

async function authenticateWithToken(token, verifiedUser, persistence) {
  if (typeof token !== 'string' || !validVerifiedUser(verifiedUser)) {
    throw new Error('Invalid authentication response.');
  }
  await setPersistence(auth, persistence);
  const credentials = await signInWithCustomToken(auth, token);
  if (credentials.user.uid !== String(verifiedUser.id)) {
    await signOut(auth);
    throw new Error('Invalid authenticated identity.');
  }
  try {
    return await loadAdminProfile(credentials.user, verifiedUser);
  } catch (error) {
    await signOut(auth);
    throw error;
  }
}

async function authenticateTelegramAdmin(initData) {
  await signOut(auth);
  const login = httpsCallable(functions, 'adminAuth');
  const response = await login({ initData });
  return authenticateWithToken(response.data?.token, response.data?.user, inMemoryPersistence);
}

async function createBrowserChallenge() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const binary = Array.from(random, byte => String.fromCharCode(byte)).join('');
  const verifier = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return {
    verifier,
    challenge: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''),
  };
}

function browserErrorMessage(error) {
  if (error?.code === 'functions/resource-exhausted') return 'Too many sign-in requests. Try again in a minute.';
  if (error?.code === 'functions/deadline-exceeded') return 'The sign-in request expired. Start a new one.';
  if (error?.code === 'functions/permission-denied') return 'The sign-in request could not be verified.';
  if (error?.code === 'functions/failed-precondition') return 'The sign-in request is no longer available.';
  if (import.meta.env.DEV && typeof error?.message === 'string') {
    return `Browser sign-in failed: ${error.message}`;
  }
  return 'Browser sign-in failed. Please try again.';
}

export function useTelegramAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [browserRequest, setBrowserRequest] = useState(null);
  const telegramAuthentication = useRef(null);
  const pollTimer = useRef(null);
  const active = useRef(true);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
      pollTimer.current = null;
    }
  }, []);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let unsubscribe = null;
    const webApp = window.Telegram?.WebApp;
    const initData = webApp?.initData;

    if (typeof initData === 'string' && initData) {
      webApp.ready();
      webApp.expand();
      telegramAuthentication.current ??= authenticateTelegramAdmin(initData);
      telegramAuthentication.current.then(
        verifiedUser => {
          if (!disposed) {
            setUser(verifiedUser);
            setLoading(false);
          }
        },
        authenticationError => {
          if (!disposed) {
            setError(authenticationError.code === 'functions/permission-denied'
              ? 'Administrator access denied.'
              : 'Authentication failed. Reopen the panel through Telegram.');
            setLoading(false);
          }
        },
      );
    } else {
      setPersistence(auth, browserSessionPersistence).then(() => {
        if (disposed) return;
        unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
          if (disposed) return;
          if (!firebaseUser) {
            setUser(null);
            setLoading(false);
            return;
          }
          try {
            const profile = await loadAdminProfile(firebaseUser);
            if (!disposed) {
              setUser(profile);
              setError(null);
              setLoading(false);
            }
          } catch {
            await signOut(auth);
            if (!disposed) {
              setUser(null);
              setError('Your browser session is no longer valid.');
              setLoading(false);
            }
          }
        });
      }).catch(() => {
        if (!disposed) {
          setError('Browser authentication could not be initialized.');
          setLoading(false);
        }
      });
    }

    return () => {
      disposed = true;
      active.current = false;
      stopPolling();
      if (unsubscribe) unsubscribe();
    };
  }, [stopPolling]);

  const startBrowserLogin = useCallback(async () => {
    stopPolling();
    setError(null);
    setBrowserRequest({ status: 'creating' });
    try {
      await signOut(auth);
      await setPersistence(auth, browserSessionPersistence);
      const { verifier, challenge } = await createBrowserChallenge();
      const begin = httpsCallable(functions, 'beginBrowserAuth');
      const response = await begin({ challenge });
      const request = response.data;
      if (!request || !/^[a-f0-9]{48}$/.test(request.requestId)
        || !/^[A-Z2-9]{6}$/.test(request.displayCode)
        || !Number.isSafeInteger(request.expiresAt) || !Number.isSafeInteger(request.pollAfterMs)) {
        throw new Error('Invalid browser authentication response.');
      }
      const botUrl = new URL(request.botUrl);
      if (botUrl.protocol !== 'https:' || botUrl.username || botUrl.password) {
        throw new Error('Invalid browser authentication destination.');
      }

      if (!active.current) return;
      setBrowserRequest({
        status: 'pending',
        displayCode: request.displayCode,
        botUrl: botUrl.toString(),
        expiresAt: request.expiresAt,
      });
      const complete = httpsCallable(functions, 'completeBrowserAuth');

      const poll = async () => {
        try {
          if (Date.now() >= request.expiresAt) {
            const expired = new Error('Expired');
            expired.code = 'functions/deadline-exceeded';
            throw expired;
          }
          const completion = await complete({ requestId: request.requestId, verifier });
          if (completion.data?.status === 'pending') {
            const delay = Number.isSafeInteger(completion.data.pollAfterMs)
              ? completion.data.pollAfterMs
              : request.pollAfterMs;
            pollTimer.current = setTimeout(poll, delay);
            return;
          }
          if (completion.data?.status !== 'approved') {
            throw new Error('Invalid browser authentication completion.');
          }
          const profile = await authenticateWithToken(
            completion.data.token,
            completion.data.user,
            browserSessionPersistence,
          );
          if (active.current) {
            setUser(profile);
            setBrowserRequest(null);
            setError(null);
          }
        } catch (pollError) {
          if (active.current) {
            setBrowserRequest(null);
            setError(browserErrorMessage(pollError));
          }
        }
      };

      pollTimer.current = setTimeout(poll, request.pollAfterMs);
    } catch (startError) {
      if (active.current) {
        setBrowserRequest(null);
        setError(browserErrorMessage(startError));
      }
    }
  }, [stopPolling]);

  const cancelBrowserLogin = useCallback(() => {
    stopPolling();
    setBrowserRequest(null);
    setError(null);
  }, [stopPolling]);

  return { user, loading, error, browserRequest, startBrowserLogin, cancelBrowserLogin };
}
