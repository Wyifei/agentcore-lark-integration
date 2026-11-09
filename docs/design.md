# Design: Chat integration with Feishu/Lark for Amazon Bedrock AgentCore

## 1. Background and goals

Agents deployed on Amazon Bedrock AgentCore Runtime have no ready-made chat interface, so customers have to build their own front end to call them. This project provides a Feishu/Lark bot as that interface:

1. **Fast registration.** Log in to the host, run one command, scan one QR code. A Feishu bot is created, configured, and bound to an AgentCore agent automatically.
2. **Chat.** Message the bot in Feishu to call the agent. The agent's streaming reply is rendered live as a readable Feishu card.
3. **Surrounding features.** Access control, session management, usage statistics, scheduled tasks.

### Non-goals

- Only agents written with **Strands Agents** are supported (event contract in section 6). Other frameworks come later.
- Only runtimes whose authorizer is "JWT, pointing at this project's Cognito user pool" are supported (5.3). Runtimes with IAM authorization, or with JWT pointing at the customer's own IdP, are not supported.
- The runtime must be in the **same account and region** as the bot host. `bind` reads the authorizer configuration with `GetAgentRuntime`, which cannot be done across accounts.
- Coding CLIs that need a terminal and a workspace (Claude Code, Codex, and similar) are not supported.
- No "stop" button. The agent side has no stop semantics (see 7.4).
- No horizontal scaling: one host, one service process.
- No web console.

## 2. Architecture

```
Feishu ⇄ WebSocket long connection (outbound only, no inbound ports)
        │
   EC2 host (private subnet, no public IP, SSM Session Manager login)
   │
   ├─ Service process: agentcore-chat-bridge serve (managed by systemd)
   │   ├─ lark/       one long connection per bot; receive, parse, authorize, de-duplicate, send cards
   │   ├─ identity/   Feishu user → userKey → Cognito user → access token
   │   ├─ session/    Feishu conversation → AgentCore runtimeSessionId; one turn at a time per conversation
   │   ├─ agentcore/  HTTPS call to the runtime (Bearer JWT), read the SSE stream, parse Strands events
   │   ├─ render/     internal events → CardKit streaming card
   │   └─ commands/   slash commands
   │
   ├─ CLI: agentcore-chat-bridge setup / bind / unbind / list / remove / status / restart / logs / admin / update / rotate-secret
   │     (run by the logged-in user; the CLI switches to the service user through sudo, see 4.7)
   │
   └─ /var/lib/agentcore-feishu-bot/   (owned by the service user afbot, 0700)
       ├─ bots.json   global settings + bot configuration (contains AppSecret, 0600)
       ├─ data.db     SQLite: sessions, de-duplication, usage
       └─ status.json run state written by the service for the CLI to read (4.6)

   /opt/agentcore-feishu-bot/          (owned by root, read-only for the service user)
       ├─ bin/afb     fixed entry script that forwards to current/
       ├─ current →  releases/<version>/
       └─ releases/<version>/  node (arm64 binary) + bundled JS + SHA256SUMS
        │
   Amazon Cognito user pool (used only to mint tokens, not for end-user sign-in)
        │
   AgentCore Runtime (the customer's Strands agent; JWT authorizer points at the user pool above)
```

- The service has no inbound ports. Feishu events and card callbacks both arrive over the long connection.
- Registration happens on the host: log in with SSM, run `setup`, and a QR code is shown in the terminal.

## 3. Technology choices

| Item | Choice |
|---|---|
| Language / runtime | TypeScript, Node.js 24 LTS |
| Feishu SDK | `@larksuiteoapi/node-sdk` (`WSClient`, `EventDispatcher`, IM / CardKit APIs) |
| AWS SDK | `@aws-sdk/client-bedrock-agentcore-control` (read runtime configuration), `@aws-sdk/client-cognito-identity-provider` (create users, mint tokens) |
| Calling the runtime | Direct HTTPS POST to `/runtimes/{arn}/invocations` with `Authorization: Bearer <JWT>`. A JWT-authorized runtime does not accept SigV4, so the SDK's `InvokeAgentRuntime` cannot be used |
| Local storage | `node:sqlite` (built into Node, no native dependency). The API is still marked as under active development, so all calls go through a thin wrapper. Read the changelog when upgrading Node minor versions |
| Terminal QR code | `qrcode-terminal` or a similar library |
| Process management | systemd |
| Infrastructure | AWS CDK (TypeScript) |
| Tests | Vitest |

## 4. Registering a Feishu bot (the `setup` command)

### 4.1 Flow

`setup` registers the app with the official SDK device-code authorization (`registerApp`). It uses only public Feishu Open Platform APIs and never holds an Open Platform login session.

```
# On your own computer
aws ssm start-session --target <instance ID>      # the full command is in the deployment outputs

# On the host
agentcore-chat-bridge setup --runtime-arn <arn> [--qualifier DEFAULT] [--app-name NAME]
  1. A QR code and a link are shown in the terminal; the user scans and confirms in the Feishu app
  2. registerApp creates the app; its addons prefill the permissions, events, and card callback from setup/scopes.json
  3. Validate the returned AppID / AppSecret (tenant_access_token) and check the bot capability (bot/v3/info)
  4. Resolve the identity of the person who scanned, as the administrator (union_id, see 4.3)
  5. Write bots.json and tell the service to load the new bot (4.5)
  6. Print the remaining manual checks in the Open Platform (4.2)
```

If `--runtime-arn` is omitted, `setup` lists the AgentCore runtimes in this account and region for the user to choose from. After the bot is registered, `setup` runs phase one of `bind` (4.6): it creates an app client for this binding, records the binding as `pending`, prints the configuration the customer's runtime needs, and prompts "run `bind --verify` once configured". **A runtime that is not configured yet does not make `setup` fail.** The client is created at this moment and the customer needs its client id before they can configure the runtime, so the first check against a brand-new runtime always fails. That is the normal state. If the runtime already passes both checks in 4.6 (for example when binding again), the binding is recorded as `ready` directly.

### 4.2 Manual checks and manually created apps

- `registerApp` cannot set everything. After `setup`, the user confirms in the Open Platform that the event and callback subscription mode is long connection, that a version is published, and that the permissions are granted. `setup` prints the link to the app and these checks. `status` then shows whether the long connection is up.
- If the user created the app by hand in the Open Platform, `setup --verify <appId>` asks for the AppSecret, validates it, and writes the bot the same way (steps 3–6).

### 4.3 Administrator identity

- `open_id` (`ou_`) is only valid in the app that issued it and **cannot be used across apps**.
- Administrators are stored as `union_id` (`on_`), email, or mobile number. Before writing, the value is resolved with the **newly created app** and verified. On a network or permission error, `setup` fails instead of guessing.

### 4.4 Permissions and events

- Events: `im.message.receive_v1` (required), `im.chat.member.bot.added_v1` / `deleted_v1`.
- Callback: `card.action.trigger` (required).
- Permissions: a minimal set that covers receiving direct messages and group @-mentions, sending messages as the bot, reading images and files in messages, writing CardKit cards, and resolving user identities. The exact list is determined by testing and kept in `setup/scopes.json`.

### 4.5 Loading a new bot without a restart

After `setup` writes `bots.json` it runs `systemctl reload agentcore-feishu-bot`. The systemd unit sets `ExecReload=/bin/kill -HUP $MAINPID`, so systemd sends `SIGHUP` to the main process it manages and no pid file is needed. On `SIGHUP` the service re-reads its configuration: new bots open a long connection, removed bots disconnect, and turns in progress for existing bots are not affected. If the service is not running, the CLI only suggests `agentcore-chat-bridge restart`.

### 4.6 Other management commands

| Command | What it does |
|---|---|
| `list` | List bots: AppID, name, each binding and its state (pending / ready), and long-connection state |
| `bind <appId> --runtime-arn <arn> [--qualifier] [--alias]` | Add an agent to a bot, in two phases. (1) Create a Cognito app client for this binding, record the state as "pending", and print the authorizer configuration the customer's runtime needs. (2) On the next run (or `bind --verify`), first use `GetAgentRuntimeEndpoint` to find the version the qualifier currently points at (authorizer configuration can be fixed per version), then read that version with `GetAgentRuntime` and check three things: `customJWTAuthorizer.discoveryUrl` points at this project's user pool, `allowedClients` contains the client, and `requestHeaderAllowlist` contains `Authorization`. Only if all hold does the state become "ready"; otherwise the command says which one is missing |
| `unbind <appId> <alias>` | Remove the binding and call `DeleteUserPoolClient` to delete its app client (and remind the customer to remove it from the runtime's `allowedClients`) |
| `remove <appId>` | Remove all bindings of the bot (same as `unbind`) and its configuration. The Feishu app itself is not deleted; the user is told to disable it in the Open Platform |
| `status` | Service process state, long-connection state of each bot, number of active sessions |
| `update` | Fetch a version from the release bucket (default `LATEST`, can be entered interactively), verify it, switch `current`, and restart (section 10). Runs as root (4.7) |
| `rotate-secret --apply` | After the administrator has written a new secret version, reset the password of existing users and reload the service (5.3) |
| `admin add <appId> <union_id\|email\|mobile>` / `admin remove` / `admin list` | Manage the bot's administrators. Email and mobile are resolved to `union_id` with the bot's own app, as in 4.3, verified, written, and then the service is reloaded |
| `allow add <appId> <union_id\|email\|mobile>` / `allow remove` / `allow list` / `allow all <appId> on\|off` | Manage who may chat (5.2). `add` / `remove` edit `allowedUsers` (resolved like `admin`). `all on` sets `allowAll: true`; before writing it warns "everyone in the visibility range can chat and each gets a Cognito user (billed per MAU, section 10)" and asks for confirmation. `list` shows the `allowAll` state and the list. The service is reloaded afterwards |
| `restart` / `logs` | Wrap `systemctl restart` and `tail -F /var/log/agentcore-feishu-bot/serve.log` |

Long-connection state exists only in the service's memory, so the CLI cannot read it directly. The service writes the connection state of each bot, the active session count, and the version to `status.json` (temporary file + rename) whenever the state changes and every 30 seconds. The CLI reads it. If the file has not been updated for 90 seconds, the CLI shows "the service may not be running".

### 4.7 Run identity and permission boundaries

`setup` and the other commands are run by the SSM login user (`ssm-user` by default). The service runs as the dedicated system user `afbot`.

| Path | Owner | Why |
|---|---|---|
| `/var/lib/agentcore-feishu-bot/` | `afbot`, 0700 | Configuration and data. `~` is not used, because the two users have different home directories |
| `/opt/agentcore-feishu-bot/` | `root`, read-only for the service user | Code and the Node runtime. If `afbot` owned it, a compromised service process could replace its own code to persist |

- **Entry point.** `/opt/agentcore-feishu-bot/bin/afb` is a fixed entry script owned by root that forwards to `current/`. sudoers matches on the command path, and an upgrade only changes the `current` symlink, so the entry path never changes. `/usr/local/bin/agentcore-feishu-bot` is a wrapper script for humans that picks the identity to run as, based on the subcommand:
  - `update` → `sudo /opt/agentcore-feishu-bot/bin/afb-update` (root);
  - other subcommands → `sudo -u afbot /opt/agentcore-feishu-bot/bin/afb <subcommand>`;
  - when a reload or restart is needed → `sudo systemctl reload|restart agentcore-feishu-bot`. `afb` runs as `afbot` and cannot use sudo, so a subcommand that changed the configuration exits with **exit code 100**, and the wrapper runs `sudo systemctl reload` (or only suggests `restart` if the service is not running). `restart` and `logs` are handled by the wrapper directly.
- **sudoers** (written to `/etc/sudoers.d/agentcore-feishu-bot` at install time):
  ```
  %afbot-admin ALL=(afbot) NOPASSWD: /opt/agentcore-feishu-bot/bin/afb *
  %afbot-admin ALL=(root)  NOPASSWD: /usr/bin/systemctl reload agentcore-feishu-bot, /usr/bin/systemctl restart agentcore-feishu-bot
  %afbot-admin ALL=(root)  NOPASSWD: /opt/agentcore-feishu-bot/bin/afb-update ""
  ```
  `afb-update` is a separate script owned by root. The `""` in sudoers restricts it to **no arguments at all**: the version is read from `releases/LATEST` in the release bucket, or typed interactively and checked against `^[0-9]+\.[0-9]+\.[0-9]+$`. The SSM Agent creates `ssm-user` on first login with passwordless sudo, so it works out of the box. Other administrators only need to join the `afbot-admin` group, not get full sudo.
- The service process, `setup`, `bind`, and the other commands all read and write the configuration as `afbot`, so `bots.json` stays 0600.

### 4.8 `/newbot`: register a new bot from inside Feishu

An administrator sends `/newbot [name]` in a **direct message** with an existing bot to register another bot without logging in to the host.

- Uses the same official device-code authorization as `setup` (SDK `registerApp`, 4.1).
- Flow:
  1. Check that the sender is an administrator of this bot and is in a direct message (the link goes only to that person and never appears in a group).
  2. The service calls `registerApp` (`addons` prefill the permissions, events, and callbacks from `setup/scopes.json`), turns the authorization link into a card button (`open_url`), and sends it to the administrator privately. The validity period is whatever the SDK returns.
  3. The administrator opens the link and confirms creation in Feishu. The service polls and gets the AppID, the AppSecret, and the open_id of the person who confirmed.
  4. Using the **new app**, resolve the open_id to a union_id and make it the new bot's administrator (4.3). If that cannot be resolved, reuse the union_id of the administrator who ran `/newbot` (union_id is the same within one developer entity).
  5. Write `bots.json` (the service writes it as afbot, 0600) and bind **the agent the requester is currently using** to the new bot (same runtime ARN, qualifier, alias `default`): create a new app client with state pending (phase one of 4.6).
  6. The service reloads its own configuration (equivalent to SIGHUP). The card is updated to "Created: <name> <appId>" and shows the client id the customer's runtime must add, plus the `bind --verify` command.
- Each bot allows only one `/newbot` in progress at a time. After the timeout (the validity period returned by the SDK, at most 10 minutes) the card is marked "expired".
- On failure only the error code is returned. The AppSecret never appears in a card or in logs.

## 5. Receiving messages, authorization, and sessions

### 5.1 Receiving messages

- One `WSClient` long connection per bot. `EventDispatcher` registers `im.message.receive_v1` and `card.action.trigger`. A dropped connection reconnects automatically.
- **De-duplication.** Write each `event_id` to SQLite (kept for 24 hours) and drop the event if it already exists. Feishu re-delivers events.
- **Parsing.** Plain text, rich text (post), images, files, and quoted replies. Files are `file` messages; when rich text contains "text + attachment", the attachment is a `file` / `media` node (6.4). Merged forwards are expanded as in 5.1.1.
- In group chats the bot responds only to messages that @-mention it. In direct messages it responds to everything.

### 5.1.1 Merged forwards

When a user "merge-forwards" a block of chat history to the bot, it is expanded into text and handed to the agent.

- Read it with `GET /open-apis/im/v1/messages/{message_id}` (without `card_msg_content_type`, otherwise a merged forward returns a 500). In the returned `items`, besides the merged-forward message itself, the child messages are those whose `upper_message_id` points at it.
- Child messages are parsed with the rules in 5.1 (text, rich text, images, files). A nested merged forward is shown only as "[merged forward]" and not expanded again.
- They are assembled as:
  ```
  [Merged-forward chat history, N messages]
  Zhang San: ...
  Li Si: [image]
  ```
  The sender name comes from the sender name returned by the API (`with_sender_name=true`), or "someone" if it is unavailable. At most 50 messages and 8000 characters; anything beyond that is truncated with a note. Images and files in child messages are attached within the limits in 6.1 and 6.4.

### 5.2 Authorization

Two kinds of people:

| Role | What they can do | Source |
|---|---|---|
| Administrator | Chat + management commands (`/agent`) | The person who scanned at registration; more are added on the host with `admin add` (4.6) |
| Chat user | Chat + ordinary commands | The `allowedUsers` list, or `allowAll: true` |

Someone who is not on the list gets a short message, and the administrators get an access-request card (5.2.1).

**Two gates.** To chat with the bot, a person has to pass both:

| | Visibility range of the Feishu app | Bot allowlist |
|---|---|---|
| Where it is configured | Feishu Open Platform → Version management → Visibility range (published with a version) | `admins` / `allowedUsers` / `allowAll` in `bots.json`, changed with the `admin` and `allow` commands (4.6) |
| What it does | Who can find and open the bot in Feishu and send it messages | Whether the bot calls the agent for this person after receiving a message |
| Initial value after `setup` | Only the person who scanned (so the version passes review automatically, 4.1) | Only the person who scanned (the administrator) |

To open the bot to the whole organization: (1) create a new version in the Open Platform, choose everyone or specific departments as the visibility range, and publish it (widening the range may need approval from the enterprise administrator, which this tool does not do for you); (2) run `allow all <appId> on`, or add people one by one with `allow add`. With only (2), people outside the range cannot find the bot. With only (1), people inside the range can send messages but are told they have no permission.

- The lists always store `union_id`. Emails and mobile numbers are resolved with the bot's own app before writing (as in 4.3).
- Removing someone from the list does not delete their Cognito user (5.3, "create only, never delete"). To block someone immediately, remove them from the list and reload; the bot stops minting tokens for them.

### 5.2.1 Access-request card for strangers

When someone who is not on the list messages the bot, the bot does more than reply "no permission": it helps them ask the administrators, with a single approval step.

- Trigger: the sender's role is "none" (5.2) and the bot's `accessRequests` setting is not `false` (on by default). Direct messages and group @-mentions both trigger it.
- The requester receives: "You do not have permission to use this bot yet. A request has been sent to the administrators and you will be notified once it is approved."
- **Anti-harassment.** One person sends at most one request per bot per 24 hours (`seen_events` records `apply:<appId>:<union_id>:<date>`). Later messages only get "Request already sent, please wait for an administrator."
- Each administrator receives a direct-message card (sent by union_id): the requester's display name (looked up as in 6.1.1, "a colleague" if it cannot be found), the source (direct message / group name), the time, and the buttons **Allow** / **Deny**. The content of the requester's message is not shown.
- On click:
  - Only an administrator of that bot can click. Each request is handled once (with several administrators, the first click wins; only the clicker's own card is updated, and other administrators who click see "already handled").
  - **Allow**: the service adds the requester's union_id to `allowedUsers` (the service writes `bots.json` atomically as afbot and then reloads) and notifies the requester privately: "Approved, you can start chatting. Please resend your last message."
  - **Deny**: the requester is notified privately: "Your request was not approved."
- No temporary grants (time or quota limits). When needed, an administrator revokes access with `allow remove`.

### 5.3 User identity and authentication

#### The unique user ID: userKey

```
userKey = "feishu:" + tenant_key + ":" + union_id
```

- `union_id` is the same across all apps of one developer entity (for an enterprise self-built app, the enterprise itself). It is in the sender information of the message event by default and needs no extra permission. The same person has the same userKey across the different bots hosted by this service (to be verified).
- `open_id` is not used: it is only valid in the app that issued it, and is a different value for another bot.
- The `feishu:` prefix marks where the identity comes from, so IDs cannot collide when other channels are added later.

#### Authentication: a user JWT issued by Cognito

Feishu is not a standard OIDC provider (no discovery URL, no id_token), so the runtime cannot verify a Feishu token directly. A Cognito user pool is therefore used **only to mint tokens** (the approach follows `sample-lark-identity-on-agentcore-native`):

```
Feishu message event (Feishu has authenticated the sender)
  → bot takes union_id and tenant_key → userKey
  → if the Cognito user (username = userKey) does not exist, create it. All three steps are required:
       1. AdminCreateUser (MessageAction: SUPPRESS, no invitation)
          — a new user is in FORCE_CHANGE_PASSWORD state, and authenticating directly returns NEW_PASSWORD_REQUIRED
       2. AdminSetUserPassword (Permanent: true), password = derived from HMAC(secret, userKey) (see below)
       3. Only then can the user authenticate
     Concurrency: two messages from a new user can trigger creation at the same time. When AdminCreateUser
          returns UsernameExistsException, treat the user as existing and continue (call AdminSetUserPassword
          once more if needed)
  → AdminInitiateAuth (ADMIN_USER_PASSWORD_AUTH, with the app client of this binding) returns an access token + refresh token
       cached in memory by (userKey, clientId); 2 minutes before the access token expires, exchange the
       refresh token for a new one (REFRESH_TOKEN_AUTH); when the refresh token is invalid, use password auth again
  → POST https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<URL-encoded ARN>/invocations?qualifier=<qualifier>
       Authorization: Bearer <access token>
       X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <runtimeSessionId>
  → the runtime verifies the signature and client ID, derives the user identity from the token's iss + sub,
    and issues a workload token to the agent
```

- **The access token must be used, not the ID token.** The runtime validates `client_id`, and only the access token has that field.
- **The derived password must satisfy the user pool password policy.** The result of `HMAC-SHA256(secret, userKey)` is base64url-encoded and a fixed suffix containing an uppercase letter, a lowercase letter, a digit, and a symbol (for example `Aa1!`) is appended, so it complies with any policy. The password policy is set explicitly in CDK and does not rely on defaults.
- **One app client per "bot × agent" binding.** When `setup` / `bind` binds an agent, it creates a new app client in the user pool, and the customer's runtime lists only that client in `allowedClients`. See "Cross-runtime replay" below for why.
  - **Operational cost.** Every binding produces a new client id that the customer must add to the runtime's `allowedClients` by hand, otherwise calls return 403. That is why binding has two phases (`bind` in 4.6): a binding does not appear among the `/agent` candidates until verification passes, and unbinding deletes the client.
- **User pool settings.** Do not enable `usernameAttributes` (email or mobile as the username), otherwise arbitrary strings cannot be used as usernames. Do not enable threat protection (advanced security): every authentication request comes from the same IP, the bot host, and would be judged a suspicious sign-in.
- **The access token is valid for 15 minutes** (set on the app client) and the refresh token for 30 days. This shortens the time a stolen token is usable.
- **Block a user with `AdminDisableUser`, not by deleting.** A disabled user can no longer get tokens, the `sub` is kept, and after `AdminEnableUser` the grants and data are still there. On the bot side the user is also removed from `allowedUsers`.
- **The Cognito `sub` is a UUID, not the username**. AgentCore identifies people by `iss + sub`, so:
  - Cognito users are **created and never deleted**. Deleting and recreating a user gives a new `sub`, which is a different person to AgentCore; the user's grants in AgentCore Identity and any data keyed by `sub` could no longer be found.
  - The agent uses the `username` in the token (= userKey) as the actorId.
- **The ability to mint tokens exists only in the bot service.** Only the bot's instance role has the `cognito-idp:AdminCreateUser` / `AdminInitiateAuth` permissions, and the HMAC secret exists only on the bot host. The reference agent's execution role has no Cognito permissions and explicitly denies `GetWorkloadAccessTokenForUserId` and `GetWorkloadAccessTokenForJWT`, so the agent cannot impersonate other users. For outbound authorization the agent uses the workload token that the runtime injects through request headers, which in theory is not affected by those two denies. The reference template should be tested once to confirm that 3LO outbound authorization still works with the denies in place.
- **The root of trust is the bot service.** It mints tokens only for senders that Feishu has just pushed and whose identity it can confirm. A compromised bot service can still mint tokens for any user; mitigations are in section 11.
- **Cross-runtime replay.** When the agent can read the `Authorization` header (it can once the header is allowed, see the runtime prerequisites below), it could use that user's token, within its validity period, to call other runtimes that trust the same user pool. Mitigations:
  - one app client per binding, and each runtime's `allowedClients` contains only its own client, so a token for another runtime fails validation here;
  - tokens are valid for 15 minutes, which limits the window;
  - remaining risk: when one runtime is bound by several bots, its `allowedClients` contains several clients, and those bots' tokens are interchangeable on that runtime. This only affects the same agent and is acceptable.
- **HMAC secret rotation.** Once the secret changes, every user's derived password changes. It is done in two steps using the `AWSCURRENT` / `AWSPREVIOUS` version labels in Secrets Manager:
  1. **The administrator, on their own computer,** writes a new version with their own credentials using `aws secretsmanager put-secret-value` (the new version automatically becomes `AWSCURRENT` and the old one `AWSPREVIOUS`). The host has only the instance role and no write permission, and `sudo -u afbot` clears environment variables, so exporting temporary credentials on the host does not work either.
  2. **On the host, run `rotate-secret --apply`.** It uses only the permissions the instance role already has: `GetSecretValue`, `ListUsers`, `AdminSetUserPassword`. It reads both versions, resets every user's password with the new secret, and then runs `systemctl reload` so the service switches to the new secret.
  - When authenticating, the service first uses the password derived from `AWSCURRENT`; if that fails it **immediately tries `AWSPREVIOUS` once and does not retry `AWSCURRENT`**, so rotation does not interrupt service. Cognito temporarily locks a user after 5 consecutive failed authentications, with the lock time doubling each time; in this order each user fails at most once per rotation, and the counter resets on success. Do not add a retry loop around password authentication. New users always use `AWSCURRENT`.
  - `--apply` takes a file lock (`/var/lib/agentcore-feishu-bot/rotate.lock`) and refuses a concurrent second rotation. If it fails midway it can be re-run, and setting the password again for users already processed is harmless.
  - Cached refresh tokens are not affected.
- **Tokens are never written to disk.** They are cached in memory only and not logged.

#### Runtime prerequisites (configuration the customer must do)

The customer's runtime must be configured with JWT authorization pointing at this project's user pool. `allowedClients` is checked against the `client_id` claim in the JWT, so the access token must be used ([Inbound JWT authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html)):

```jsonc
"authorizerConfiguration": {
  "customJWTAuthorizer": {
    "discoveryUrl": "https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration",
    "allowedClients": ["<app client id of this binding>"]
  }
},
"requestHeaderConfiguration": {
  "requestHeaderAllowlist": ["Authorization"]
}
```

- JWT authorization and IAM authorization on a runtime are **mutually exclusive**: after switching to JWT the runtime no longer accepts SigV4 calls. `authorizerConfiguration` is a runtime-level setting made on `CreateAgentRuntime` / `UpdateAgentRuntime`. Tested: the authorizer configuration is **fixed per version** (after the runtime is switched to JWT, an endpoint pinned to an older version still accepts SigV4). There are two migration options for the customer:
  - **Create a new runtime (recommended).** Create a JWT-authorized runtime from the same image for this bot and leave the original runtime alone, so both sides can keep releasing.
  - **Pin the old version.** First create an endpoint pinned to the current (last IAM) version for the existing IAM callers and switch them to it, then change the runtime to JWT. Every later version is JWT-authorized, and the pinned endpoint's code is frozen at that version, so this is only suitable as a transition.
- For the agent to read user information from the token, the runtime **must** allow `Authorization` in `requestHeaderAllowlist`. The documentation states that when a custom JWT authorizer is configured, the `Authorization` header is forwarded to the agent after validation and the agent reads it from `context.request_headers` ([Pass custom headers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html)). The reference agent template ships with this setting.
- The binding flow and the checks are defined by `bind` in 4.6 (`discoveryUrl` points at this project's user pool, `allowedClients` contains this binding's client, `requestHeaderAllowlist` contains `Authorization`). If a check fails, the binding stays `pending`, and the tool prints the configuration above ready to use (with this binding's client id) and the impact of the change, and leaves the decision to the customer. **Neither `setup` nor `bind` modifies the customer's runtime.**

### 5.4 Session model

| Scenario | Session anchor |
|---|---|
| The message has a `thread_id` (a topic in a topic group, or a topic reply in a normal group) | `thread_id` |
| Anything else (direct message, normal group) | `chat_id` |

- `root_id` is not used. It is the root of a "quote reply" chain, and splitting by it would start a new session for every quote reply in a group.
- Reply location: for a message with a `thread_id`, use the reply API with `reply_in_thread: true` so the reply lands in the same topic. In a direct message, send directly. In a normal group, quote the user's message without creating a new topic.

```
sessionKey       = appId + "|" + anchor + "|" + userKey
runtimeSessionId = "fs-" + first 40 hex characters of sha256(sessionKey + "|" + agentAlias + "|" + epoch)   (43 characters, meeting the 33-character minimum)
```

- **Sessions are per user, even in groups.** A runtime session maps to one microVM and the state in the agent's memory. If several people shared one, what A read with A's own authorization could be asked out by B in the same session. The cost is that in a shared topic the agent does not remember what others said (the replies are in the group, so people can see them). If a "shared group context" is needed later, make it a per-bot setting and disable per-user third-party authorization for that bot.
- **Each agent keeps its own current conversation.** Under one conversation location (sessionKey), the currently selected agent is recorded on the session, and each agent alias has its own `epoch` (conversation generation), starting at 0.
  - `/agent <alias>` switches using that alias's **current** epoch, so it continues that agent's last conversation. `/new` increments only the current alias's epoch.
  - `agentAlias` is part of the `runtimeSessionId` calculation. Otherwise two agents at epoch 0 would get the same ID, and if they share one Memory resource their conversation histories would mix.
  - Whether a conversation can really be continued also depends on the agent. An agent connected to AgentCore Memory can continue within the Memory retention period. One that only keeps history in memory cannot continue once the microVM is reclaimed (after 15 minutes idle) and is treated as a new conversation.
  - Conversations from old epochs are not deleted. `/resume` can switch back to them (8.1).
  - Each agent's conversation records the runtime ARN. If the same alias is rebound to a different runtime, a new conversation starts automatically (epoch + 1) and the old conversation ID is not given to the new runtime. Rebinding to the same runtime continues the original conversation.
  - The table schema is migrated with `PRAGMA user_version`. When upgrading from the old schema (v1), existing conversations restart once because the ID algorithm changed; `last_prompt` and the current alias are kept.
- **A runtime session is not conversation memory.** A microVM is reclaimed after 15 minutes idle or 8 hours in total, and conversation history held only in memory is lost. So `runtimeSessionId` is also passed to the agent as `conversationId` (6.1), and the reference agent uses AgentCore Memory to store the conversation by `(actorId, conversationId)`, so a new microVM can continue it. After a session ends, calling again with the same `runtimeSessionId` starts a new microVM that continues serving ([Configure lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)). The Memory `actorId` allows colon-separated segments and `sessionId` allows the `fs-<hex>` format ([CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html)).

### 5.5 Serial execution and queueing

A Strands Agent does not support handling two turns of the same session at once, so **turns within a session are strictly serial**:

- While a turn is running, a new message goes into that session's in-memory FIFO queue and gets a "queued (position N)" card. When its turn comes, the card becomes the streaming card.
- The queue has a limit (5 by default). Beyond it the user is asked to try again later.
- It is a single process, so no cross-process session lock is needed.
- This serialization is **required**: the runtime allows up to 250 concurrent connections per session ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)) and will not queue for us.
- When the service stops (`systemctl stop` / restart / upgrade), it stops accepting new messages and waits for turns in progress (up to 60 seconds). The card of a turn that times out is marked "service restarted, interrupted", and the cards of queued messages are marked "not executed, please resend".

## 6. Calling AgentCore and the Strands event contract

### 6.1 Request

```
POST https://bedrock-agentcore.<region>.amazonaws.com/runtimes/<URL-encoded runtime ARN>/invocations?qualifier=<qualifier>
Authorization: Bearer <this user's Cognito access token>          // 5.3
X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: <runtimeSessionId>   // 5.4
Content-Type: application/json
Accept: text/event-stream
```

```jsonc
{
  "prompt": "...",                                   // the user's message, already parsed into text
  "images": [{ "mimeType": "...", "dataBase64": "..." }], // optional; at most 5, each <= 10 MB, <= 20 MB in total; extras are not attached and the prompt says so
  "files": [{ "name": "...", "mimeType": "...", "sizeBytes": 0, "dataBase64": "..." }], // optional, see 6.4
  "actorId": "feishu:<tenant_key>:<union_id>",       // for reference only; the agent trusts the username in the JWT
  "conversationId": "<runtimeSessionId>",            // used as the session_id for AgentCore Memory
  "turnId": "...",                                   // ID of this turn, for log correlation
  "user": { "name": "..." },                         // display name, optional, see 6.1.1; used only to address the user, never for authorization
  "chat": { "chatType": "p2p" | "group", "chatId": "...", "threadId": "..." }
}
```

- The runtime ARN and qualifier come from the bot configuration or `/agent`.
- The agent **does not trust** identity fields in the payload. It decides "who" only from the JWT (which the runtime has verified).
- Unknown fields (for example `files` sent to an agent that does not support files) are ignored and do not fail the call.

### 6.1.1 Letting the model know who the user is

Identity is present all along the call chain (the JWT `username` = userKey, which the agent code uses to isolate Memory), but by default it reaches **only the agent code, not the model**. The model cannot see the JWT and the reference template does not put the identity into the prompt, so if the user asks "do you know who I am", the model says no. To have the model address the user or personalize answers:

**Bot side: fill in `user.name`**

- A Feishu message event contains only the sender ID, not the name. The first time a userKey is seen, the bot uses that bot's app to call the contacts API (`contact.v3.user.get`, `user_id_type=union_id`; it needs `contact:user.base:readonly`, already in `setup/scopes.json`) to look up the display name.
- The result is cached in memory (by userKey, expiring after 24 hours; looked up again after a service restart). It is **never written to disk or to logs**.
- If it cannot be found (permission not in effect, the user is outside the app's visibility range, an API error), `user.name` is left out and the call proceeds as usual without blocking the conversation. Only the error code is logged.
- In group chats the name is filled in per sender, and each call carries only its own sender's name.

**Agent side (reference template): add a "current user" to the system prompt**

```
Current user: <user.name, or "unknown" if absent>
(The user's identity has been verified by the system. You may use this name to address the user. Never reveal any internal identifier to the user.)
```

- **Identity comes from the JWT.** actorId, Memory, and user-data lookups in tools use only the JWT `username`. A caller holding a valid token can forge the payload, so `user.name` is **used only to address the user and never for any authorization decision**.
- **union_id / userKey are not told to the model by default.** This keeps the model from saying internal IDs in replies and prevents prompt injection from tricking it into using them to impersonate someone. For tools that need the user ID, the agent code injects it into the tool arguments directly from the JWT (the model does not fill in that argument when calling the tool).
- The name is read from the payload on every turn. If the user renames themselves in Feishu, it takes effect on the next turn (subject to the bot's 24-hour cache).
- The system prompt is distinguished per actorId and never mixed: the Agent objects are cached by `(actorId, conversationId)` anyway.

### 6.2 Streaming events: two layers of compatibility

The agent's entry function returns events with `yield`, and the client receives `text/event-stream`, one `data: <json>` line per event. A single streaming event can be at most 64 KB ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)), so the reference template sends only a summary for large tool results.

**Layer 1: the recommended contract (the reference agent template outputs this)**

```jsonc
{"type": "text",       "delta": "..."}
{"type": "reasoning",  "delta": "..."}
{"type": "tool_start", "id": "t1", "name": "search", "input": {...}}
{"type": "tool_end",   "id": "t1", "status": "success" | "error", "summary": "first line of the result"}
{"type": "usage",      "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "model": "..."}
{"type": "done"}
{"type": "error",      "message": "..."}
{"type": "interrupt",  "id": "...", "name": "...", "title": "...", "detail": "...", "options": [{"label": "...", "value": "..."}]}   // see 6.5
```

`usage` is **incremental**: one per model call (several inside a tool loop), and the bot accumulates them. `tool_start` may appear several times with the same `id`, and later ones complete `input`.

`examples/strands-agent/` provides a reference agent. It reads the raw Strands events with `agent.stream_async()`, converts them to the format above, and then `yield`s them.

**Layer 2: direct compatibility with raw Strands events (best-effort parsing)**

When the customer's agent `yield`s raw Strands events directly, they are parsed with these rules:

| Raw event | Mapped to |
|---|---|
| `event.contentBlockDelta.delta.text` | `text` |
| `event.contentBlockDelta.delta.reasoningContent.text` | `reasoning` |
| `event.contentBlockStart.start.toolUse` | `tool_start` |
| `toolResult` in `message` | `tool_end` |
| `event.metadata.usage` | `usage` |
| `data` is a string (an unrecognized event) | treated as `text` |

Raw Strands events contain objects that cannot be JSON-serialized, so this layer is best effort. The reference template converts events to layer 1 before yielding.

### 6.3 Completion and errors

- Receiving `done`, or the stream ending normally, means the turn succeeded.
- Receiving `error`, an HTTP error, or an interrupted stream means the turn failed. The card shows an error code and a generic explanation, and the raw error goes only to the log.
- **By convention the agent returns HTTP 200 even on errors** and sends an `error` event in the stream before ending it. AgentCore wraps non-2xx responses in a `RuntimeClientError` and discards the response body, so the client would see only a generic error. The reference template does this.
- **Per-turn timeout** (10 minutes by default, configurable per bot). On timeout the stream is closed, the card is marked "timed out", and the next queued message is processed. The hard limit for a streaming connection is 60 minutes ([quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)), so `turnTimeoutSec` is validated when the configuration is read and a value **greater than 3600 is rejected**.

### 6.4 Files

The agent on AgentCore Runtime is custom code whose payload we define, so files are passed directly in the request body (the payload limit is 100 MB, [quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)). No extra storage or tools are needed.

**Bot side**

- Parsing: `file` messages (the content has `file_key` and `file_name`), and `media` inside rich text. Files in merged forwards follow the same rules (5.1.1).
- Download: `im.v1.messageResource.get` (`type=file`). The message content has no file size, so the download counts bytes as it reads and aborts as soon as the limit is exceeded.
- Limits (configurable per bot): a single file <= 20 MB, files in one turn <= 50 MB in total, at most 5 per turn. Base64 inflates size by about 33%, and with images it stays within 100 MB. When a limit is exceeded, the bot replies "file too large" with the limit and does not call the agent.
- Payload: `files: [{ name, mimeType, sizeBytes, dataBase64 }]`. `name` is the original file name in Feishu (the agent must sanitize it before writing to disk). `mimeType` is inferred from the extension and the file header, and falls back to `application/octet-stream`.
- File only, no text: the agent is still called once, with the prompt "The user uploaded files: <file name> (<size>)", and the agent stores the file and acknowledges briefly. Users usually ask "summarize this file" in the next message.
- Card: when the turn carries files, the status line shows "N files attached". The bot cannot know whether the agent supports `files`.
- Nothing is written to disk: the bot does not store file contents. The `last_prompt` used by `/retry` records only `message_id` + `file_key` + `file_name`, and a resend downloads the file from Feishu again (same as for images).
- Logs: only the number, type, and size of files are logged, never the file names (which may be sensitive) or contents.
- Each turn sends only the files in that turn's message. Referring to earlier files in later turns is the agent's job (see below).

**Agent-side convention** (the reference template implements it, and customer agents should adapt to it)

- Handling in the current turn:
  - A document format Bedrock supports (PDF, DOC/DOCX, XLS/XLSX, CSV, HTML, TXT, MD) within the model limit (about 4.5 MB): convert it to a Strands / Bedrock `document` content block for the model to read directly.
  - Other text (code, logs, JSON, and so on): decode it and put only the beginning in the prompt (the reference template: 8,000 characters, with the total length and how to read further). The rest is read on demand with `read_uploaded_file(name, offset)`, at most 20,000 characters per call. The inlined part stays in the conversation history and is resent on every later turn, so it must stay small.
  - Other formats, or over the limit: only tell the model "the file is saved at some path" and let a tool read it (for example Python parsing, or AgentCore Code Interpreter).
- Referring to files across turns: the agent writes files to this session's storage (under `uploads/`, with a sanitized file name) and reads them in later turns as needed.
  - The microVM's local disk is valid only while this microVM is alive.
  - To keep files across microVMs, use AgentCore session storage (1 GB per session): `filesystemConfigurations` mounts it at `/mnt/<dir>`, and retention across microVMs has been tested. The reference template mounts it at `/mnt/afb`, puts files under `uploads/`, and provides `list_uploaded_files` / `read_uploaded_file` tools.
  - **The name of a document block must be unique within the whole conversation**, so add a random suffix on every generation.
- Isolation: files are handled only in that user's own runtime session (a separate microVM), and sessions are per user (5.4). The bot does no malware scanning on files and relies on microVM isolation. The agent must not execute files uploaded by users.

**Large files** (not planned; recorded only as an option)

For files that exceed the inline limit or must be reused across conversations, switch to "upload to S3 + pass only the key in the payload + read with a tool":

- Keys are prefixed per user: `uploads/<hash of userKey>/<uuid>`.
- The reading tool (a tool inside the agent, or AgentCore Gateway + Lambda) must take the user identity from the verified JWT and check that the key prefix belongs to that user. Bucket-level permission of the "can only read this directory of this bucket" kind is not enough: if the model were tricked into reporting someone else's key, it would read across users.
- The bucket is private and encrypted, with a lifecycle rule that deletes objects automatically (for example after 7 days).

### 6.5 Human confirmation

Some operations need the user's confirmation before they run (deleting data, submitting an order, sending an email), or need the user to pick one of several options. Only the agent knows "which tool is about to run and whether confirmation is needed", so the agent initiates it, and the bot renders the buttons and sends the user's choice back. 3LO authorization is not involved (3LO needs a public callback endpoint and is designed separately).

**Flow: every step is a separate call**

```
Turn 1: user message → the agent pauses with a Strands interrupt before the tool that needs confirmation
        → yield {"type":"interrupt", "id", "name", "title", "detail", "options"} → yield {"type":"done"}
        → bot: the final card shows the title, the description, and the option buttons; the turn ends normally and the session queue is released
User clicks a button → card.action.trigger
        → the bot answers within 2.5 seconds and changes the button to "Selected: Confirm" and disables it
        → queues a "resume call" turn on that session's queue
Turn 2: same runtimeSessionId, payload carries "resume": {"interruptId": "...", "value": "..."}, prompt is empty
        → the agent continues from the interrupt (runs or cancels the tool) and replies as a stream; it may interrupt again, repeating the above
```

The bot does not wait for the user inside one stream: a streaming connection lasts at most 60 minutes, the session queue would stay blocked the whole time, and it would conflict with "no stop semantics" (7.4).

**Agent side** (the reference implementation uses AgentCore Memory)

- Use native Strands interrupts: in a `BeforeToolCallEvent` hook, call `event.interrupt(name, reason={title, detail, options})` for tools that need confirmation, and set `event.cancel_tool` when the response is not a confirmation value.
- When the turn ends with `stop_reason == "interrupt"`, yield one `interrupt` event per interrupt (use the Strands interrupt id as `id`, without parsing it), then yield `done`.
- On receiving `resume`, assemble `[{"interruptResponse": {"interruptId": ..., "response": value}}]` and call `agent.stream_async(...)`. Strands continues from the interrupt and does not call the model again to decide the next step.
- Interrupt state is kept across microVMs: `AgentCoreMemorySessionManager` persists it, tested. On an unknown or already-handled `resume`, reply "the confirmation has expired, please start again".
- The system prompt must tell the model "call the tool directly for operations that need confirmation; the system will show confirmation buttons", otherwise the model asks for confirmation in text first.
- One turn can have several interrupts. Only the first one is rendered, and the others appear one after another after resuming in the next turn.

**Bot side**

- Event: recognizes `interrupt` (the layer-1 contract in 6.2). Agents that do not know interrupts never send it, so behavior is unchanged for them.
- Rendering: the final card shows `title`, `detail`, and buttons (at most 5 options) after the body, and the title status is "waiting for confirmation".
- Value carried by a button callback: `{a: "resume", u: asker's union_id, sk: hash of sessionKey, al: agent alias, ep: epoch, iid: interruptId, v: value, exp: expiry time}`.
- Click validation. If any check fails, the bot only returns a toast and does not call the agent:
  - only the asker can click (same as "regenerate");
  - the conversation location, agent alias, and epoch are all still current (old buttons become invalid after `/new` or `/agent`);
  - not expired (24 hours by default, configurable per bot);
  - not already clicked: a given interrupt is accepted only once, tracked by recording `resume:<interruptId>` in `seen_events`.
- The resume call goes through the session queue (5.5), the timeout (6.3), and the streaming card (7) as usual, and the card is marked "Continue: selected <label>".
- If the user sends a new message while waiting for confirmation, it is sent to the agent as a new turn as usual, and the earlier buttons stay valid until they are clicked, expire, or the conversation changes. How the agent handles an unresolved interrupt when it receives an ordinary message is up to the agent (the reference template cancels the unanswered interrupt and handles the new message).
- No extra message text is stored: a button value holds only IDs and the option value, and the title and description exist only on the card.

## 7. Rendering: CardKit streaming cards

### 7.1 Card structure (Card 2.0)

```
[Title]   Thinking / Replying · 12.3s        (color changes with state)
[Collapsible panel] Reasoning                (only when there is reasoning)
[Tool list] ⏺ search(keywords…)
            └ 5 results found
[Body]    markdown, updated while streaming (element_id = "answer")
[Footer]  Input 1.2k · Output 380 · model · session total
[Buttons] Regenerate · View trace            (only after the turn ends)
```

There are two card layouts. In CardKit streaming mode, interactive components such as collapsible panels and buttons are restricted, so:

- **Streaming layout**: only three markdown elements: `status` (the tail of the reasoning / "Thinking…"), `tools` (the tool list), and `answer` (the body). The title is fixed to its initial state and does not show a live elapsed time (the title is not an element, and updating it would mean replacing the whole card).
- **Final layout**: when the turn ends, one `card.update` swaps in the full structure shown above (title with state and elapsed time, collapsible reasoning panel, tools, body, footer, buttons) and turns off `streaming_mode`.

### 7.2 Streaming updates

Writing a card with CardKit streaming:

1. Send a Card 2.0 card in the streaming layout, with each element carrying an `element_id` (starting with a letter, at most 20 characters). `streaming_mode` (`print_frequency_ms: 70, print_step: 1, print_strategy: 'fast'`) is written directly in this card's `config`, which saves one `settings` call. When a queued card's turn comes, `card.update` replaces it in place with the streaming layout.
2. Use `idConvert` to convert the message ID to a card ID.
3. If the card ID cannot be obtained, this turn does no streaming updates and writes the final card with `im.message.patch` at the end.
4. `text` events accumulate in a buffer. Card writes happen in a **separate write queue**: each write sends only the latest full text (intermediate versions are dropped), and the next write is sent only after the previous one finishes. A CardKit write was measured at about 470 ms (361–606 ms, from `sample-lark-identity-on-agentcore-native`), so the actual cadence is set by write latency. Do not write synchronously inside the stream-reading loop, otherwise the text stutters. The Feishu client does the typewriter animation itself.
5. Changes to the status line, the tool list, and the body are merged into the same tick, and only elements whose content changed are written (`cardElement.content`). After 3 consecutive write failures, streaming writes stop and the whole card is replaced at the end. The minimum tick interval is 150 ms.
6. At the end, turn off `streaming_mode`, set the summary (at most 50 characters), and update the title, footer, and buttons.

- All updates to one card are **serialized** (a per-card queue, with later updates merged) to avoid reordering.
- If CardKit rate limits are hit, increase the tick interval.

### 7.3 Length limits

- A single write of the body is at most 30,000 characters, and a whole card request is at most 30,000 bytes.
- When exceeded, the card body keeps the first part and says "the full reply is in the file below", and the full content is sent as an `.md` file in the same conversation.
- Markdown is adapted to Feishu cards (headings, tables, code blocks).

### 7.4 No stop

The agent side has no stop semantics, and closing the HTTP stream does not stop a turn that is already running, so there is no stop button and no `/stop`. A turn that does not end for a long time is covered by the per-turn timeout (6.3).

### 7.5 Buttons

| Button | Behavior |
|---|---|
| Regenerate | Same as `/retry` |
| View trace | Jumps to the AgentCore observability page in CloudWatch, (the AgentCore observability overview for the region) |

| Interrupt option (6.5) | Sends the user's choice to the agent as `resume`, continuing on the same session |

Feishu requires a card callback to be answered within **3 seconds**. This project uses 2.5 seconds to leave a margin: answer first, then do the work asynchronously.

## 8. Slash commands

All commands are registered in one table: name, aliases, whether administrator rights are needed, whether an existing session is needed, and help text.

| Command | Permission | Behavior |
|---|---|---|
| `/new` | Chat user | End the current conversation of the **current agent**: that agent's `epoch` is incremented and the next message uses a new `runtimeSessionId`. Conversations with other agents are not affected. Queued messages are discarded and `last_prompt` is cleared (so `/retry` and the "Regenerate" button on old cards do not send a message from the previous conversation into the new one). A turn in progress completes as usual. The old microVM is not stopped actively and is reclaimed by AgentCore after idling |
| `/status` | Chat user | The bound agent (runtime ARN, endpoint), the current session ID, token totals for this session, the duration of the last turn, and the queue length |
| `/retry` | Chat user | Resend the last user message in this session |
| `/agent` | Administrator | Without arguments: list this bot's bindings whose state is "ready" (those that passed `bind` verification in 4.6). `/agent <alias>`: switch the agent used at the **current conversation location** (recorded in `sessions.agent_alias`, the bot's `defaultAgent` is unchanged) and **continue that agent's last conversation here** (5.4). The reply says "continuing the previous conversation" or "starting a new conversation" (the first time that agent is used). Queued messages are discarded (so they are not sent to another agent), `last_prompt` is cleared, and a turn in progress completes as usual. New agents can only be added on the host with `bind` |
| `/help` | Everyone | List the commands |
| `/resume` | Chat user | See 8.1: list recent conversations at this conversation location; `/resume <number>` switches back |
| `/schedule` | Administrator | Send a message to this conversation on a schedule |

Not applicable and not implemented: `/stop` `/restart` `/cd` `/repo` `/term` `/adopt` `/compact` `/effort` `/cli` `/rewind` `/fork` `/login` (all of them concern a local CLI process or a workspace).

### 8.1 `/resume`

A direct-message window has only one conversation location, and after `/new` the old conversation cannot be reached. (In a topic group every topic is its own session and is not affected.) `/resume` lets the user switch back to an old conversation at this location.

- **How it works.** The `runtimeSessionId` of an old conversation is determined by `sessionKey`, the agent alias, and the old `epoch`, so it can be recomputed, and the agent restores the history from AgentCore Memory by `(actorId, conversationId)` (5.4). Switching back means setting the current alias's epoch back to the old value. The agent is not called.
- **`/resume`.** Lists the 10 most recent conversations at this location for the **current agent** (for another agent's conversations, switch to it with `/agent` first and then `/resume`). Each item shows a number, the start time, the number of turns, and a title. The current conversation is marked "(current)".
- **`/resume <number>`.** Switch back to that conversation.
  - The rules are the same as for `/new`: queued messages are discarded, `last_prompt` is cleared, and a turn in progress completes as usual.
- **Title.** The first 20 characters of the first user message of the conversation, with line breaks and leading and trailing whitespace removed. A message with only an image is recorded as "[image]". With `storePromptText: false` no title is stored and the list shows only time and turn count.
- **Beyond the retention period** (30 days, the same as the retention of the reference agent's Memory events), conversations are no longer listed and the records are cleaned up periodically. If the customer's agent has a shorter Memory retention, the history may not be restored after switching back, and the agent can treat it as a new conversation.
- A user can only switch back to **their own** conversations at **this conversation location** (`conversations` is queried by `session_key`, which contains the userKey).

### 8.2 Usage statistics

Only the numbers already in the `turns` table are counted, with no message content.

- Host command `usage [appId] [--days 7]`, Feishu command `/usage [days]` (administrators, this bot only, 7 days by default and at most 90).
- Summarized by bot × agent alias: number of turns, successes / failures / timeouts, active users (distinct userKeys), input / output tokens, average duration, and median time to first token; then turns and tokens per day.
- The `turns` table is kept for 90 days and cleaned up periodically.

### 8.3 `/schedule` scheduled tasks

An administrator sets a scheduled message at a conversation location. At the due time it is sent to the current agent **as that administrator**, and the reply appears at that conversation location.

- Commands (administrators):
  - `/schedule add <time> <message>`: the time is one of `每天 HH:MM` (every day), `工作日 HH:MM` (weekdays), `每周一 HH:MM` (every week on that day; 一 二 三 四 五 六 日, i.e. Monday to Sunday), `每 N 分钟` (every N minutes, N >= 10), or `每 N 小时` (every N hours). The keywords are Chinese because the bot's command parser and card text are in Chinese. The time zone is the bot's `timezone` setting, `Asia/Shanghai` by default.
  - `/schedule list`: list the tasks at this conversation location (number, time, next run, first 20 characters of the message).
  - `/schedule remove <number>`.
- Execution:
  - The service checks for due tasks every 30 seconds. A due task enters that conversation's queue (5.5) as if the user had sent the message, using the creator's conversation with the current agent at that location (5.4).
  - Reply location: in a direct message, send directly; in a group, send a new message (no quote); in a topic, reply into that topic. The card title is prefixed with "⏰ scheduled task".
  - If the creator is no longer an administrator, the bot was deleted, or the binding is unavailable, the task is skipped and disabled.
  - Missed runs (while the service was down) are not made up; only the next run counts.
- At most 50 tasks per bot. The message content has to be stored (the feature needs it). It lives in the `schedules` table, is under the administrator's control, can be deleted at any time, and is not affected by `storePromptText`.

## 9. Data

### 9.1 `/var/lib/agentcore-feishu-bot/bots.json`

Global settings + bot configuration, permission 0600, written atomically with "temporary file + rename".

```jsonc
{
  "schemaVersion": 1,
  "settings": {
    "userPoolId": "ap-northeast-1_xxx",
    "hmacSecretArn": "arn:aws:secretsmanager:…"
  },
  "bots": [{
    "appId": "cli_xxx",
    "appSecret": "…",
    "appName": "Support assistant",
    "agents": [{
      "alias": "default",
      "runtimeArn": "arn:aws:bedrock-agentcore:…:runtime/…",
      "qualifier": "DEFAULT",
      "clientId": "…",                         // the Cognito app client of this binding (5.3)
      "status": "pending",                     // "pending" | "ready", the two phases of bind in 4.6
      "verifiedAt": null                       // time of the last successful verify
    }],
    "defaultAgent": "default",
    "admins": ["on_xxx"],
    "allowedUsers": [],
    "allowAll": false,
    "turnTimeoutSec": 600,                     // <= 3600 (6.3)
    "storePromptText": true,                   // whether to store last_prompt and conversation titles (9.2); the old name keepLastPrompt is still accepted
    "createdAt": "2026-11-05T00:00:00Z"
  }]
}
```

- `defaultAgent` must be one of the aliases in `agents`. When `agents` is empty (for example, binding failed after `setup`), an empty string is allowed.
- The service handles messages only for bindings with `status: "ready"`. When the binding that `defaultAgent` points at is not `ready`, the chat tells the administrator to finish `bind --verify` first.
- `schemaVersion` is validated on read, and migrations will be written when the structure changes.

### 9.2 `/var/lib/agentcore-feishu-bot/data.db` (SQLite)

| Table | Primary key | Main fields |
|---|---|---|
| `sessions` | `session_key` | `app_id`, `chat_id`, `thread_id`, `user_key`, `agent_alias` (the currently selected agent; empty means the bot's `defaultAgent`), `last_prompt`, `last_turn_at` |
| `session_agents` | `session_key` + `agent_alias` | `epoch`, `runtime_session_id`, `usage_totals` (JSON, cumulative usage of that agent's current conversation), `last_turn_at`. One row per agent used at each conversation location (5.4) |
| `seen_events` | `event_id` | `seen_at` (rows older than 24 hours are cleaned up periodically) |
| `conversations` | `session_key` + `agent_alias` + `epoch` | `title` (first 20 characters of the first message, may be empty), `agent_alias`, `started_at`, `last_turn_at`, `turns` (number of turns). Used by `/resume` (8.1) |
| `turns` | `turn_id` | `session_key`, `agent_alias`, start / end time, time to first token, tokens, result (success / failure / timeout), error code. Kept for 90 days (8.2) |
| `schedules` | `id` | `app_id`, `session_key`, `union_id`, `chat_id`, `chat_type`, `thread_id`, `spec` (time rule), `prompt` (message content), `next_run_at`, `enabled`, `created_at` (8.3) |

- Only the minimum text needed for features is stored, and all of it is controlled by the bot setting `storePromptText` (on by default; when off, none of it is stored):
  - `sessions.last_prompt`: the full text of the last user message, for `/retry` and "Regenerate". One per session, overwritten, and cleared on `/new` and `/resume`.
  - `conversations.title`: the first 20 characters of the first message of each conversation, for the `/resume` list. Records older than 30 days are deleted periodically.
- Image contents are not stored, only `message_id` + `image_key`. A resend downloads them from Feishu again.
- Message text lives only in the local SQLite (`/var/lib/agentcore-feishu-bot/`, `afbot` 0700, encrypted root volume and snapshots) and is never logged or uploaded.

## 10. Deployment (EC2)

- **Instance.** `t4g.small` (Graviton, Amazon Linux 2023), 20 GiB encrypted gp3 root volume. The load is only long connections and streaming HTTP; adjust the size to the memory actually used once it runs.
- **Network.** Private subnet, no public IP. The security group has **no inbound rules**. Outbound access to Feishu and the AWS APIs goes through a NAT gateway. An existing VPC can be reused.
- **Login.** SSM Session Manager. The deployment outputs include the `aws ssm start-session --target <instance ID>` command.
- **Installation.** User data fetches the package from the release bucket (see below), creates the `afbot` user and the `afbot-admin` group, writes sudoers (4.7) and the systemd unit `agentcore-feishu-bot.service`: `User=afbot`, `ExecStart=/opt/agentcore-feishu-bot/current/node …`, `Restart=always`, `TimeoutStopSec=90` (matching the shutdown flow in 5.5), `ExecReload=/bin/kill -HUP $MAINPID` (matching 4.5), `StandardOutput=append:/var/log/agentcore-feishu-bot/serve.log`, and `StandardError` to the same file.
- **Logs.** The CloudWatch Agent does not read journald directly, so service logs go to `/var/log/agentcore-feishu-bot/serve.log` and the CloudWatch Agent collects them. logrotate rotates daily and keeps 7 files, using `copytruncate` (in `append:` mode systemd holds the file handle).
- **Instance role (least privilege).**
  - Calling the runtime needs no IAM permission (it uses JWT authorization).
  - `cognito-idp:AdminCreateUser` / `AdminSetUserPassword` / `AdminInitiateAuth` / `AdminGetUser` / `AdminDisableUser` / `AdminEnableUser` / `ListUsers`: limited to this project's user pool.
  - `cognito-idp:CreateUserPoolClient` / `DescribeUserPoolClient` / `DeleteUserPoolClient`: `bind` / `unbind` manage the app client of each binding, limited to this project's user pool.
  - `bedrock-agentcore:ListAgentRuntimes` / `GetAgentRuntime` / `GetAgentRuntimeEndpoint` / `ListAgentRuntimeEndpoints`: lets `setup` list agents and check the authorizer configuration of the version an endpoint currently points at.
  - `secretsmanager:GetSecretValue`: read-only on the one secret that holds the HMAC password-derivation key (including the `AWSPREVIOUS` version). Writing a new version is done by the administrator on their own computer (5.3).
  - The SSM managed policy (Session Manager).
  - CloudWatch Agent permission to write logs.
- **Cognito user pool.** Created by CDK, self sign-up disabled, password policy set explicitly. App clients are created by `setup` per binding with only `ADMIN_USER_PASSWORD_AUTH` and `REFRESH_TOKEN_AUTH` enabled, a 15-minute access token and a 30-day refresh token (the Admin APIs are protected by IAM, so the client needs no secret). The HMAC key is in Secrets Manager. The user pool has deletion protection and `RemovalPolicy.RETAIN`, so it is not deleted with the stack (deleting it would give every user a new identity, see 5.3).
- **Cognito billing.** Billed per monthly active user (MAU). A bot has few users, so this can be ignored, but when a bot with `allowAll: true` is added to a large group chat, MAU grows with it.
- **Backup.** Data Lifecycle Manager snapshots the root volume daily and keeps 7 days (`bots.json` and SQLite are both on the root volume). Snapshots contain plaintext AppSecret: the root volume is encrypted and snapshots inherit that. The DLM policy has no cross-account sharing or cross-region copy, and the `ec2:CreateVolume` / `ModifySnapshotAttribute` permissions on snapshots go only to administrators, not to the instance role.
- **Release package.** The project is bundled with esbuild into one JS file (`node:sqlite` is built in, so there are no native dependencies). It is packed into a tarball **together with the official Node.js 24 linux-arm64 binary** and `SHA256SUMS`, so the package is fully self-contained: the official Amazon Linux 2023 repository may not have Node 24, and downloading from nodejs.org would need public internet access. At packaging time the Node binary is verified against the official `SHASUMS256.txt` (and its GPG signature). Release artifacts: `releases/<version>/agentcore-feishu-bot-<version>.tar.gz` plus a sidecar `….tar.gz.sha256` in the same directory, and `releases/LATEST` (containing the version number). The bucket is versioned, and the bucket policy lets only the deployment role write.
- **First deployment order.** One `npm run deploy` does everything: it first runs `npm run release` locally to build the artifacts and then `cdk deploy`. The stack uses `BucketDeployment` (`prune: false`, so old versions are kept) to upload the artifacts to the release bucket, and **the host instance declares a dependency on this `BucketDeployment`**, so `LATEST` always exists when the instance starts. For upgrades afterwards, `npm run release -- --upload` uploads only the new version and updates `LATEST`, and then you run `update` on the host. No new `cdk deploy` is needed. The README describes the deployment steps in this order.
- **Initial configuration.** User data gets the user pool ID, HMAC secret ARN, and release bucket name from CDK, and on first boot generates `/var/lib/agentcore-feishu-bot/bots.json` (`{"schemaVersion":1,"settings":{…},"bots":[]}`, owned by `afbot`, 0600). An existing file is not overwritten. `bind` reads `settings.userPoolId` directly when creating a client.
- **Install and upgrade.** User data and `agentcore-chat-bridge update` share one fetch script that pulls the given version from this bucket (through the S3 gateway VPC endpoint, not the public internet):
  1. Download the tarball and the sidecar, and check that the tarball's sha256 matches the sidecar. The sidecar and the tarball are in the same bucket, so this **protects only against transfer corruption, not tampering**. Tamper protection comes from giving write access to the bucket only to the deployment role, which is acceptable.
  2. Before unpacking, list the entries: only regular files and directories are allowed (symbolic links, hard links, and device files are rejected), and any path containing `..` or an absolute path is rejected. Then unpack as root with `tar --no-same-owner` into a temporary directory (GNU tar strips a leading `/` by default; `--no-absolute-filenames` is a cpio option and does not apply).
  3. Verify the unpacked files against the `SHA256SUMS` inside the package, and do not allow any file other than those in `SHA256SUMS`. Only then move them to `/opt/agentcore-feishu-bot/releases/<version>/`.
  4. Switch the `current` symlink, run `host/install-host.sh` from the package to update the host files (`afb`, `afb-update`, the fetch script, the wrapper script, sudoers (after `visudo -c`), the systemd unit, logrotate, and the CloudWatch Agent configuration), and restart the service. If any step fails, the link stays on the old version. The fetch script and bootstrap are embedded in user data the first time and are updated with the release package afterwards. `npm install` is never run on the host. The instance role has only `s3:GetObject` on `releases/*` of that bucket.
- **Local development.** The same code runs locally with `npm run dev`, using local AWS credentials and a separate data directory.

## 11. Security and observability

- The host has no inbound ports and no public IP. Only IAM identities that can start an SSM session to the instance can log in, so only they can run `setup` and see the QR code.
- `bots.json` contains the AppSecret, has permission 0600, and is owned by the service's dedicated user. It is never logged.
- The ability to mint tokens exists only in the bot service (5.3), and user tokens are cached only in memory. If the bot host is compromised, tokens can be minted for any user. Mitigations:
  - SSM login permission goes to a few administrators only, with `ssm:StartSession` limited by instance ID / tag.
  - The access token is valid for 15 minutes, which limits how long a stolen token can be used.
  - CloudTrail → CloudWatch alarms: a spike in calls to `AdminInitiateAuth`, `AdminCreateUser`, and `AdminSetUserPassword` (baseline ≈ daily active users × bindings used per person × password authentications per binding per day; the last is small once refresh tokens are in use), and calls from identities other than the instance role.
  - After a compromise is found: stop the instance → rotate the HMAC key (5.3) and run `AdminUserGlobalSignOut` for all users → rotate each bot's AppSecret.
  - **A stolen access token cannot be revoked early.** `AdminUserGlobalSignOut` only invalidates refresh tokens (so they cannot be renewed). The runtime verifies signatures offline with JWKS and does not check a revocation list, so an access token that has already been issued stays usable for its remaining lifetime (at most 15 minutes). The only option is to wait for it to expire. To stop the damage at once, the customer can only remove the client from the runtime's `allowedClients` temporarily.
- Logs do not record message text, only the sessionKey, turnId, duration, tokens, and error code. Only the minimum text needed for features, which can be turned off, is stored locally (9.2).
- Error messages shown to users contain only an error code and a generic explanation.
- Logs: written to a file and collected by the CloudWatch Agent (section 10).
- Agent-side traces come from AgentCore Observability, and "View trace" on the card jumps there.

## 12. Verified service behavior

**Tested in ap-northeast-1:**

| Conclusion |
|---|
| The direct HTTPS call format is correct: `POST /runtimes/<encodeURIComponent(ARN)>/invocations?qualifier=…`, `Authorization: Bearer`, `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`, and the response is `text/event-stream` with one `data: <json>` per event. The layer-1 events of the reference template arrive unchanged. When raw Strands events are yielded as they are: `{"event": …}` (including `contentBlockDelta` / `contentBlockStart.toolUse` / `metadata.usage`) and `{"message": …}` (including `toolResult`) are valid JSON. Callback-style events containing an `Agent` object, and `result`, are serialized by the SDK with `str()` into **Python repr strings** (`"{'data': …, 'agent': <…>}"`) and must be dropped, otherwise the body is duplicated and garbled. Normalization with the layer-2 rules gives correct text, tools, and usage. Samples are in `test/fixtures/` |
| Access token fields: `sub` (UUID), `username` (= userKey), `client_id`, `token_use: "access"`, `iss`. The runtime forwards the verified `Authorization` to the agent, and the reference template takes `username` from it successfully |
| The authorizer configuration is fixed per version: after `UpdateAgentRuntime` switches to JWT, a new version is created, `DEFAULT` points at it and rejects SigV4 (`Authorization method mismatch`). An endpoint pinned to the old version still accepts SigV4, and `GetAgentRuntime(old version)` is still IAM. See 5.3 for migration guidance |
| Merged forward: the child message fields returned by `GET /im/v1/messages/{id}` (`upper_message_id`, `msg_type`, `body.content`) and the location of the sender name (the field name when `with_sender_name=true`) (5.1.1) |
| (1) Session storage is enabled with `filesystemConfigurations: [{"sessionStorage": {"mountPath": "/mnt/<dir>"}}]` (the path must be one level under `/mnt`), and after `StopRuntimeSession` a new microVM can still read the files written earlier. (2) The model can read PDF and CSV through a Strands `document` block. **The `name` of a document block must not repeat within the whole conversation**, otherwise every later turn of that conversation fails with `ValidationException`, and since the history is already stored in Memory it cannot recover on its own. The reference template adds a random suffix to every document name. (3) A payload of about 40 MB (a 30 MB file in base64) works over HTTPS; sending it from a local machine took about 22 seconds including the upload, and streaming responses were not affected |
| Strands interrupt state is kept across microVMs through `AgentCoreMemorySessionManager` (Strands 1.64 / bedrock-agentcore 1.25): interrupt → `StopRuntimeSession` → the new microVM receives `resume` and the tool continues from the interrupt. Repeated confirmation, cancellation, an ordinary message while waiting for confirmation (cancel first, then answer), and old buttons all behave as described in 6.5. **By default the model asks for confirmation in text first instead of calling the tool**, so the reference template's system prompt requires "call the tool directly for operations that need confirmation; the system will show confirmation buttons" |
| Anonymous requests and forged tokens are both blocked by JWT authorization (401) |
| AgentCore Memory stores by `(actorId, conversationId)`: after `StopRuntimeSession`, calling again with the same `runtimeSessionId` lets a new microVM continue the conversation, and another user cannot read it even by reusing the same `runtimeSessionId` (identity comes from the JWT) |
| **A runtime session is not bound to the caller's identity.** Another valid token can enter the same microVM with the same `runtimeSessionId`. The bot's sessionKey contains the userKey, so this does not happen, but it shows that "sessions are per user" in 5.4 is necessary, and an agent must not assume that microVM memory belongs to a single user |

**From the official documentation:**

| Conclusion | Source |
|---|---|
| A synchronous request lasts 15 minutes; a streaming connection (SSE / WebSocket) at most 60 minutes; an asynchronous task 8 hours (microVM). The default per-turn timeout of 10 minutes is within range, and the upper limit is validated at 3600 seconds (6.3). WebSocket and asynchronous submission are no longer evaluated | [Quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) |
| Allow `Authorization` in `requestHeaderAllowlist`; when a custom JWT authorizer is configured, it is forwarded to the agent after validation | [Pass custom headers](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-header-allowlist.html) |
| `allowedClients` is checked against the JWT `client_id`, so the access token must be used; a `discoveryUrl` pointing at a Cognito user pool is standard usage | [Inbound JWT authorization](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/inbound-jwt-authorizer.html) |
| After a session ends, the same `runtimeSessionId` starts a new microVM that continues | [Lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html) |
| userKey with colons: Cognito usernames allow punctuation; the Memory `actorId` allows colon-separated segments and `sessionId` allows `fs-<hex>` | [CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html) |
