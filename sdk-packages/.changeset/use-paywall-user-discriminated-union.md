---
'@monetize.software/sdk-react': major
---

**BREAKING**: `usePaywallUser()` now returns a discriminated `PaywallUserState`
union instead of `PaywallUser | null`.

```ts
type PaywallUserState =
  | { status: 'loading'; user: null; session: null }
  | { status: 'guest'; user: null; session: null }
  | { status: 'signed_in'; user: PaywallUser | null; session: AuthSession | null };
```

Why: the old shape conflated three states under `null` — Provider not yet
mounted, bootstrap in flight, and "really signed out". Hosts had to fall back
to reading `paywall.auth?.getCachedSession()` to distinguish "guest" from
"loading", which was both undocumented and easy to forget. The new shape
makes the lifecycle explicit and lets `PaywallUserState['status']` narrow the
rest of the snapshot.

The hook now also subscribes to `authChange` (not just `userChange`), so
sign-in / sign-out transitions update the component automatically.

Migration:

```tsx
// before
const user = usePaywallUser();
if (!user) return <SignInCTA />;
return <Profile user={user} />;

// after
const account = usePaywallUser();
if (account.status === 'loading') return <Skeleton />;
if (account.status === 'guest') return <SignInCTA />;
if (!account.user) return <Skeleton />;
return <Profile user={account.user} />;
```

Also exports `PaywallUserState` and re-exports `AuthSession` for convenience.
