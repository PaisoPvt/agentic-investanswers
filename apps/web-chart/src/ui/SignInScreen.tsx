// The sign-in screen (M2-14): sign in, or create an account, on the app's own
// sign-in (M2-08). Every rule (email format, password length, a taken email,
// a wrong password, too many attempts) is the server's; its message is shown
// as it is.

import type { SessionResponse } from '@aia/client-contract';
import { useState } from 'react';
import type { FormEvent } from 'react';

import type { PlatformClient } from '../data/platform-client.js';

export interface SignInScreenProps {
  readonly client: Pick<PlatformClient, 'startSession'>;
  readonly onSession: (session: SessionResponse) => void;
}

export function SignInScreen({ client, onSession }: SignInScreenProps) {
  const [kind, setKind] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setFailure(undefined);
    try {
      onSession(await client.startSession(kind, email, password));
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : 'could not reach the server');
      setBusy(false);
    }
  };

  const signUp = kind === 'sign-up';
  return (
    <main className="sign-in">
      <form className="card" data-testid="sign-in" noValidate onSubmit={(e) => void submit(e)}>
        <h1>InvestAnswers Charts</h1>
        <p className="lead">{signUp ? 'Create your account' : 'Sign in to your account'}</p>
        <label htmlFor="email">Email</label>
        <input id="email" data-testid="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="password">Password</label>
        <input
          id="password"
          data-testid="password"
          type="password"
          autoComplete={signUp ? 'new-password' : 'current-password'}
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {signUp && <small>At least 10 characters.</small>}
        {failure !== undefined && (
          <p className="error" role="alert" data-testid="sign-in-error">
            {failure}
          </p>
        )}
        <button type="submit" data-testid="sign-in-submit" disabled={busy}>
          {busy ? 'One moment…' : signUp ? 'Create account' : 'Sign in'}
        </button>
        <p className="switch">
          {signUp ? 'Already have an account?' : 'New here?'}{' '}
          <button
            type="button"
            className="link"
            data-testid="sign-in-switch"
            onClick={() => {
              setKind(signUp ? 'sign-in' : 'sign-up');
              setFailure(undefined);
            }}
          >
            {signUp ? 'Sign in' : 'Create an account'}
          </button>
        </p>
      </form>
    </main>
  );
}
