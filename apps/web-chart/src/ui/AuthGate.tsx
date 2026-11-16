// Who is using the chart (M2-14): asks the platform (GET /auth/me) before the
// chart opens. Signed in: the chart, with the account and Sign out. Signed out:
// the sign-in screen. A platform without sign-in (developer access, locally):
// the chart straight away, as before.

import type { AccountInfo, SessionResponse } from '@aia/client-contract';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { PlatformClient } from '../data/platform-client.js';
import { storeToken } from '../data/platform-client.js';
import { SignInScreen } from './SignInScreen.js';

/** What the chart shows about the session: nothing in developer access. */
export interface Session {
  readonly account: AccountInfo;
  readonly signOut: () => void;
}

export interface AuthGateProps {
  readonly client: Pick<PlatformClient, 'me' | 'startSession' | 'signOut'>;
  readonly children: (session: Session | undefined) => ReactNode;
}

type State = { readonly kind: 'checking' } | { readonly kind: 'open' } | { readonly kind: 'signed-out' } | { readonly kind: 'signed-in'; readonly account: AccountInfo } | { readonly kind: 'failed'; readonly message: string };

export function AuthGate({ client, children }: AuthGateProps) {
  const [state, setState] = useState<State>({ kind: 'checking' });

  useEffect(() => {
    let current = true;
    client.me().then(
      (who) => {
        if (!current) return;
        if (who === 'open') setState({ kind: 'open' });
        else if (who === undefined) {
          storeToken(undefined); // expired or revoked
          setState({ kind: 'signed-out' });
        } else setState({ kind: 'signed-in', account: who });
      },
      (error: unknown) => current && setState({ kind: 'failed', message: error instanceof Error ? error.message : 'could not reach the server' }),
    );
    return () => {
      current = false;
    };
  }, [client]);

  const onSession = (session: SessionResponse) => {
    storeToken(session.token);
    setState({ kind: 'signed-in', account: session.account });
  };

  const signOut = () => {
    void client.signOut();
    storeToken(undefined);
    // A fresh page drops the live connection and everything the signed-in user loaded.
    window.location.reload();
  };

  switch (state.kind) {
    case 'checking':
      return <p className="message">Loading…</p>;
    case 'failed':
      return (
        <p className="message" role="alert">
          {state.message}
        </p>
      );
    case 'signed-out':
      return <SignInScreen client={client} onSession={onSession} />;
    case 'open':
      return <>{children(undefined)}</>;
    case 'signed-in':
      return <>{children({ account: state.account, signOut })}</>;
  }
}
