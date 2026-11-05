# GitHub OAuth Prototype — Setup Guide

> Prototype only. Token held in-memory, no encryption/refresh/persistence. Scalable hexagonal design allows hardening later.

## 1. Create GitHub OAuth App

1. Go to https://github.com/settings/developers -> **OAuth Apps** -> **New OAuth App**
2. Fill:
   - **Application name:** `SingulariTree (local dev)`
   - **Homepage URL:** `http://localhost:4200` (or `http://localhost:53682` for loopback)
   - **Authorization callback URL:** `http://localhost:53682/callback`
     - Must match `GITHUB_REDIRECT_PORT` + `GITHUB_REDIRECT_PATH` in `.env` / `GITHUB_REDIRECT_PORT` env var.
     - For Go + Electron loopback server, default port is `53682`. If you change it, update both the OAuth App and `.env`.
3. After creation, note **Client ID** and generate **Client Secret**.

## 2. Configure env

```bash
cp .env.example .env
# edit .env
# GITHUB_CLIENT_ID=Iv1.xxxxx
# GITHUB_CLIENT_SECRET=xxxxx
# GITHUB_REDIRECT_PORT=53682
# GITHUB_SCOPES=read:user repo
```

Electron reads via `process.env` (main) and forwards to Go via `--github-client-id` / env. Go reads `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` via `config.Load()`.

Scaffold accepts placeholder values — if `GITHUB_CLIENT_ID` missing, `StartGitHubOAuth` returns `MISSING_CLIENT_ID` error handled in Angular toast.

## 3. Scopes

Prototype requests `read:user repo` (from routing packet acceptance criteria). This covers:
- `GET https://api.github.com/user` — profile
- `GET https://api.github.com/user/repos?per_page=30` — repo list

Adjust `GITHUB_SCOPES` for iteration; Go's `StartGitHubOAuthResponse.auth_url` encodes `scope` param.

## 4. Flow (OAuth Web Application Flow)

```
Angular [Login with GitHub] -> ipcRenderer.invoke('auth:startGitHubOAuth')
  -> Electron main: generate state (crypto.randomBytes 16 hex), build auth_url:
     https://github.com/login/oauth/authorize?client_id=...&redirect_uri=http://localhost:53682/callback&scope=read:user repo&state=...
  -> shell.openExternal(auth_url)
  -> loopback http server (Electron main `auth.ts` listening 127.0.0.1:53682) captures GET /callback?code=...&state=...
  -> validates state, closes server, returns code to Angular via IPC or directly calls Go
  -> Go: POST https://github.com/login/oauth/access_token {client_id, client_secret, code} Accept: application/json -> {access_token}
  -> Go stores token in-memory TokenStore (sync.RWMutex)
  -> Angular calls GetGitHubUser / ListGitHubRepos via IPC -> Go forwards to api.github.com with Authorization: Bearer <token>

Logout: Angular -> auth:logout -> Go clears TokenStore, Electron clears state.
```

Token is held in-memory across IPC:
- Angular `AuthStore` (signals) keeps `authenticated`, `user`, `repos` for UI.
- Electron holds `pendingState` for CSRF check.
- Go `TokenStore` is source of truth for API calls (hexagonal AuthService). Angular -> Electron -> Go via gRPC/Connect or HTTP fallback (`supervisor.forwardToGo`).

## 5. Demo verification

After login:
- Angular displays `GET /user` (login, name, avatar) and `GET /user/repos` list.
- Errors: cancel in browser -> `OAUTH_CANCELLED`, 401/403 -> toast + re-login, missing Client ID -> `MISSING_CLIENT_ID` toast, network/rate-limit -> retry.

## 6. Security deferred (out of scope for prototype)

- Token not encrypted, not persisted, lost on restart.
- No refresh (GitHub OAuth tokens are long-lived unless revoked).
- Loopback server binds 127.0.0.1 only, validates `state`, closes after single callback, no PKCE yet.
- Later iteration: add PKCE, secure storage (keychain via Electron safeStorage), refresh, encryption at rest.

## 7. Hexagonal extensibility

- `domain/auth.go` defines `AuthPort` + `TokenStore` interfaces.
- `service/auth_service.go` orchestrates.
- `adapter/github/github_client.go` implements `AuthPort` (http.Client injectable).
- `adapter/auth/oauth.go` handles code->token exchange.
- Swapping storage (keychain) or adding PKCE touches only adapters/service, not UI.

## 8. Troubleshooting

- **Callback not received:** check firewall, ensure OAuth App callback URL exactly `http://localhost:53682/callback`, check `GITHUB_REDIRECT_PORT` not in use (`lsof -i :53682`).
- **400 bad_verification_code:** code already used or expired (10 min); restart login.
- **No Client ID:** set `GITHUB_CLIENT_ID` in `.env` and restart Electron + Go core.
