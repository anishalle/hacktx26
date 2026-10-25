import AsyncStorage from '@react-native-async-storage/async-storage';
import { createContext, ReactNode, use, useCallback, useEffect, useMemo, useState } from 'react';

import { api, type User } from '@/api';

const KEY = 'demo_user_id';

type Session = {
  users: User[];
  me: User | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  setMe: (userId: string) => void;
  reload: () => void;
  userById: (id: string | null | undefined) => User | undefined;
};

const SessionContext = createContext<Session | null>(null);

/** Demo "auth": whichever user is picked in the switcher. Persisted across launches. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<User[]>([]);
  const [meId, setMeId] = useState<string | null>(null);
  const [status, setStatus] = useState<Session['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, saved] = await Promise.all([
          api.getUsers(),
          AsyncStorage.getItem(KEY).catch(() => null),
        ]);
        if (cancelled) return;
        setUsers(list);
        setMeId(saved && list.some((u) => u.id === saved) ? saved : (list[0]?.id ?? null));
        setStatus('ready');
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const setMe = useCallback((id: string) => {
    setMeId(id);
    AsyncStorage.setItem(KEY, id).catch(() => {});
  }, []);

  const value = useMemo<Session>(() => {
    const map = new Map(users.map((u) => [u.id, u]));
    return {
      users,
      me: (meId && map.get(meId)) || null,
      status,
      error,
      setMe,
      reload: () => {
        setStatus('loading');
        setAttempt((n) => n + 1);
      },
      userById: (id) => (id ? map.get(id) : undefined),
    };
  }, [users, meId, status, error, setMe]);

  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession() {
  const ctx = use(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** The current demo user. Only call below the ready gate in the root layout. */
export function useMe(): User {
  const { me } = useSession();
  if (!me) throw new Error('No current user');
  return me;
}
