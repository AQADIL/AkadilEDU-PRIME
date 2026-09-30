import { useEffect, useRef, useState } from 'react';
import { inMemoryPersistence, setPersistence, signInWithCustomToken, signOut } from 'firebase/auth';
import { httpsCallable } from 'firebase/functions';
import { auth, db, functions, get, ref } from '../lib/firebase';

async function authenticateAdmin(initData) {
  await signOut(auth);
  await setPersistence(auth, inMemoryPersistence);

  const login = httpsCallable(functions, 'adminAuth');
  const response = await login({ initData });
  const token = response.data?.token;
  const verifiedUser = response.data?.user;

  if (typeof token !== 'string' || !verifiedUser || !Number.isSafeInteger(verifiedUser.id)) {
    throw new Error('Invalid authentication response.');
  }

  const credentials = await signInWithCustomToken(auth, token);
  if (credentials.user.uid !== String(verifiedUser.id)) {
    await signOut(auth);
    throw new Error('Invalid authenticated identity.');
  }

  try {
    const snapshot = await get(ref(db, `admins/${verifiedUser.id}`));
    if (!snapshot.exists()) {
      throw new Error('Administrator access has been revoked.');
    }

    return { ...verifiedUser, role: snapshot.val().role, isAdmin: true };
  } catch (error) {
    await signOut(auth);
    throw error;
  }
}

export function useTelegramAuth() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const authentication = useRef(null);

  useEffect(() => {
    let active = true;
    const webApp = window.Telegram?.WebApp;
    const initData = webApp?.initData;

    if (typeof initData !== 'string' || !initData) {
      signOut(auth).then(
        () => {
          if (active) {
            setError('Open this admin panel through Telegram.');
            setLoading(false);
          }
        },
        () => {
          if (active) {
            setError('Authentication failed. Reopen the panel through Telegram.');
            setLoading(false);
          }
        },
      );
      return () => { active = false; };
    }

    webApp.ready();
    webApp.expand();
    authentication.current ??= authenticateAdmin(initData);

    authentication.current.then(
      verifiedUser => {
        if (active) {
          setUser(verifiedUser);
          setLoading(false);
        }
      },
      authenticationError => {
        if (active) {
          setError(authenticationError.code === 'functions/permission-denied'
            ? 'Administrator access denied.'
            : 'Authentication failed. Reopen the panel through Telegram.');
          setLoading(false);
        }
      },
    );

    return () => { active = false; };
  }, []);

  return { user, loading, error };
}
