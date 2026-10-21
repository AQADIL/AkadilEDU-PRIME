import { useCallback, useEffect, useRef, useState } from 'react';
import {
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
  onAuthStateChanged,
  setPersistence,
  signInWithCustomToken,
  signOut,
} from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, get, ref } from '../lib/firebase';

class AdminAccessError extends Error {}
const stayLoggedInKey = 'akadiledu.stayLoggedIn';

function readStayLoggedIn() {
  try { return window.localStorage.getItem(stayLoggedInKey) !== 'false'; }
  catch { return true; }
}

function validVerifiedUser(user) {
  return user && Number.isSafeInteger(user.id) && user.id > 0;
}

async function loadAdminProfile(firebaseUser, verifiedUser = null) {
  if (!/^\d{1,16}$/.test(firebaseUser.uid)) {
    throw new AdminAccessError('Invalid authenticated identity.');
  }
  const id = Number(firebaseUser.uid);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AdminAccessError('Invalid authenticated identity.');
  }

  const [adminSnapshot, profileSnapshot] = await Promise.all([
    get(ref(db, `admins/${firebaseUser.uid}`)),
    get(ref(db, `users/${firebaseUser.uid}`)),
  ]);
  if (!adminSnapshot.exists()) {
    throw new AdminAccessError('Administrator access has been revoked.');
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
  if (error?.code === 'functions/resource-exhausted') return 'Too many attempts. Request a new code.';
  if (error?.code === 'functions/deadline-exceeded') return 'Code expired. Request a new one.';
  if (error?.code === 'functions/permission-denied') return 'The sign-in request could not be verified.';
  if (error?.code === 'functions/failed-precondition') return 'The sign-in request is no longer available.';
  if (import.meta.env.DEV && typeof error?.message === 'string') {
    return `Browser sign-in failed: ${error.message}`;
  }
  return 'Browser sign-in failed. Please try again.';
}

function recoverableOtpError(error) {
  const reason = error?.details?.reason;
  if (reason === 'invalid-code') return 'Incorrect code. Try again.';
  if (reason === 'code-not-sent') return 'Open Telegram to receive your code.';
  return null;
}

function motionDelay() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 180 : 1050;
}

function wait(milliseconds) {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

export function useTelegramAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [verificationError, setVerificationError] = useState(null);
  const [browserRequest, setBrowserRequest] = useState(null);
  const [stayLoggedIn, setStayLoggedIn] = useState(readStayLoggedIn);
  const telegramAuthentication = useRef(null);
  const browserCredentials = useRef(null);
  const verificationInFlight = useRef(false);
  const browserAuthenticationInProgress = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    let disposed = false;
    let unsubscribe = null;
    let authRevision = 0;
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
      setPersistence(auth, readStayLoggedIn() ? browserLocalPersistence : browserSessionPersistence).then(() => {
        if (disposed) return;
        unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
          if (disposed || browserAuthenticationInProgress.current) return;
          const revision = ++authRevision;
          if (!firebaseUser) {
            setUser(null);
            setLoading(false);
            return;
          }
          try {
            const profile = await loadAdminProfile(firebaseUser);
            if (!disposed && revision === authRevision) {
              setUser(profile);
              setError(null);
              setLoading(false);
            }
          } catch (restoreError) {
            if (disposed || revision !== authRevision) return;
            const invalidSession = restoreError instanceof AdminAccessError || [
              'PERMISSION_DENIED', 'database/permission-denied', 'auth/user-disabled',
              'auth/user-token-expired', 'auth/invalid-user-token',
            ].includes(restoreError?.code);
            if (invalidSession) await signOut(auth).catch(() => undefined);
            if (!disposed) {
              setUser(null);
              setError(invalidSession ? 'Your browser session is no longer valid.'
                : 'Could not verify your saved session. Check your connection and reload.');
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
      browserCredentials.current = null;
      if (unsubscribe) unsubscribe();
    };
  }, []);

  const startBrowserLogin = useCallback(async () => {
    if (verificationInFlight.current) return;
    setError(null);
    setVerificationError(null);
    setBrowserRequest({ status: 'creating' });
    browserCredentials.current = null;
    try {
      await signOut(auth);
      await setPersistence(auth, stayLoggedIn ? browserLocalPersistence : browserSessionPersistence);
      const { verifier, challenge } = await createBrowserChallenge();
      const begin = httpsCallable(functions, 'beginBrowserAuth');
      const response = await begin({ challenge });
      const request = response.data;
      if (!request || !/^[a-f0-9]{48}$/.test(request.requestId)
        || !Number.isSafeInteger(request.expiresAt)) {
        throw new Error('Invalid browser authentication response.');
      }
      const botUrl = new URL(request.botUrl);
      if (botUrl.protocol !== 'https:' || botUrl.username || botUrl.password) {
        throw new Error('Invalid browser authentication destination.');
      }

      if (!active.current) return;
      browserCredentials.current = {
        requestId: request.requestId,
        verifier,
        expiresAt: request.expiresAt,
        stayLoggedIn,
      };
      setBrowserRequest({
        status: 'pending',
        botUrl: botUrl.toString(),
        expiresAt: request.expiresAt,
      });
    } catch (startError) {
      if (active.current) {
        browserCredentials.current = null;
        setBrowserRequest(null);
        setError(browserErrorMessage(startError));
      }
    }
  }, [stayLoggedIn]);

  const verifyBrowserOtp = useCallback(async (otp) => {
    if (!/^\d{4}$/.test(otp) || verificationInFlight.current) return;
    const credentials = browserCredentials.current;
    if (!credentials) {
      setBrowserRequest(null);
      setError('Request a new code.');
      return;
    }
    if (Date.now() >= credentials.expiresAt) {
      browserCredentials.current = null;
      setBrowserRequest(null);
      setError('Code expired. Request a new one.');
      return;
    }

    verificationInFlight.current = true;
    setVerificationError(null);
    setBrowserRequest(current => current ? { ...current, status: 'verifying' } : current);
    try {
      const complete = httpsCallable(functions, 'completeBrowserAuth');
      const response = await complete({
        requestId: credentials.requestId,
        verifier: credentials.verifier,
        otp,
      });
      if (response.data?.status !== 'approved') {
        throw new Error('Invalid browser authentication completion.');
      }
      browserAuthenticationInProgress.current = true;
      const profile = await authenticateWithToken(
        response.data.token,
        response.data.user,
        credentials.stayLoggedIn ? browserLocalPersistence : browserSessionPersistence,
      );
      if (!active.current) return;
      setBrowserRequest(current => current ? { ...current, status: 'success' } : current);
      const delay = motionDelay();
      if (delay > 0) await wait(delay);
      if (active.current) {
        browserCredentials.current = null;
        browserAuthenticationInProgress.current = false;
        setUser(profile);
        setBrowserRequest(null);
        setError(null);
      }
    } catch (verificationFailure) {
      browserAuthenticationInProgress.current = false;
      if (!active.current) return;
      const recoverable = recoverableOtpError(verificationFailure);
      if (recoverable) {
        setVerificationError(recoverable);
        setBrowserRequest(current => current ? { ...current, status: 'pending' } : current);
      } else {
        browserCredentials.current = null;
        setBrowserRequest(null);
        setError(browserErrorMessage(verificationFailure));
      }
    } finally {
      verificationInFlight.current = false;
    }
  }, []);

  const cancelBrowserLogin = useCallback(() => {
    if (verificationInFlight.current) return;
    browserCredentials.current = null;
    setBrowserRequest(null);
    setVerificationError(null);
    setError(null);
  }, []);

  const logout = useCallback(async () => {
    await signOut(auth);
    browserCredentials.current = null;
    setUser(null);
    setBrowserRequest(null);
    setVerificationError(null);
    setError(null);
  }, []);

  const updateStayLoggedIn = useCallback((value) => {
    if (typeof value !== 'boolean' || verificationInFlight.current) return;
    setStayLoggedIn(value);
    try { window.localStorage.setItem(stayLoggedInKey, String(value)); }
    catch { return; }
  }, []);

  return {
    user,
    loading,
    error,
    verificationError,
    browserRequest,
    startBrowserLogin,
    verifyBrowserOtp,
    cancelBrowserLogin,
    logout,
    stayLoggedIn,
    updateStayLoggedIn,
  };
}
