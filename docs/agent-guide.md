# Agent development guide

This is a scaffold document for agent developers. To make a Strands agent deployed on AgentCore Runtime fully usable in Feishu/Lark through this sample's bot, it lists what the agent's design must satisfy and how to write the code for each capability.

- Based on [`docs/design.md`](design.md) ("design x.y" below refers to its sections). If the two disagree, the design document wins.
- Reference implementation: [`examples/strands-agent/agent.py`](../examples/strands-agent/agent.py), with the deployment script [`examples/strands-agent/deploy/deploy.py`](../examples/strands-agent/deploy/deploy.py). It uses AgentCore Memory.

**Capabilities**

| Capability | Bot side | Section here |
|---|---|---|
| Streaming text, reasoning, tools, usage | Implemented | 1.4 |
| JWT identity, per-user isolation | Implemented | 1.3 |
| Conversation memory (AgentCore Memory) | Implemented (the bot only passes IDs) | 1.5 |
| Images | Implemented | 2.1 |
| Files | Implemented | 2.2 |
| Letting the model know the user's name | Implemented | 2.3 |
| Human confirmation (buttons) | Implemented | 2.4 |
| Third-party OAuth (3LO) | Not supported (needs a separate callback endpoint design) | 2.7 |

---

## 1. General requirements (mandatory)

### 1.1 Prerequisites

- **Framework.** Strands Agents (Python). Other frameworks also work as long as they emit the events in 1.4, but they are not in the supported scope.
- **Deployment.** AgentCore Runtime, HTTP protocol, arm64. A container image or direct code deployment (zip) both work.
- **Location.** The **same account and region** as the bot host (`bind` reads the runtime's authorizer configuration, design 1).
- **Authentication.** The runtime must be configured with **JWT pointing at the bot's Cognito user pool** and must allow the `Authorization` request header (1.2). Runtimes with IAM authorization are not supported.

### 1.2 Runtime configuration

`agentcore-chat-bridge setup` / `bind` creates a new app client for every binding and prints the configuration below. Call `CreateAgentRuntime` / `UpdateAgentRuntime` with it:

```jsonc
"authorizerConfiguration": {
  "customJWTAuthorizer": {
    "discoveryUrl": "https://cognito-idp.<region>.amazonaws.com/<userPoolId>/.well-known/openid-configuration",
    "allowedClients": ["<app client id printed by bind>", "..."]   // add all of them when one runtime is bound by several bots
  }
},
"requestHeaderConfiguration": { "requestHeaderAllowlist": ["Authorization"] }
```

- After configuring, run `agentcore-chat-bridge bind --verify <appId> <alias>` on the host. The binding becomes "ready" only when all three checks pass (design 4.6).
- **JWT and IAM authorization are mutually exclusive**, and the authorizer configuration is fixed per runtime version (tested). If the original runtime still has IAM callers: the recommended approach is to create a separate JWT runtime from the same image. The transitional approach is to first create an endpoint pinned to the current version for the IAM callers and then switch the runtime to JWT.
- `UpdateAgentRuntime` replaces the configuration as a whole: whenever you update code or environment variables, **always include** `authorizerConfiguration`, `requestHeaderConfiguration`, and `environmentVariables`, otherwise they are cleared (`deploy.py --authorizer-json` handles this).
- Lifecycle: by default a microVM is reclaimed after 15 minutes idle and after 8 hours at most. The bot's per-turn timeout is 10 minutes by default (configurable per bot, at most 60 minutes), and one turn of the agent must finish within that range.

### 1.3 Identity: trust only the JWT

After the runtime verifies the JWT, it forwards the `Authorization` header to the agent, which reads it from `context.request_headers`. The token is a Cognito **access token** with these fields (tested):

| Field | Value |
|---|---|
| `username` | userKey: `feishu:<tenant_key>:<union_id>`. **The user's identity is defined by it** |
| `sub` | The UUID of the Cognito user |
| `client_id` | The app client of this binding |
| `token_use` | `access` |

```python
def actor_from_jwt(context: RequestContext) -> str:
    headers = {k.lower(): v for k, v in (context.request_headers or {}).items()}
    auth = headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise AuthError("missing bearer token")      # the runtime does not allow the Authorization header
    payload_b64 = auth.split(" ", 1)[1].split(".")[1]
    claims = json.loads(base64.urlsafe_b64decode(payload_b64 + "=" * (-len(payload_b64) % 4)))
    if claims.get("token_use") != "access" or not claims.get("username"):
        raise AuthError("bad token")
    return claims["username"]
```

- The signature has already been verified by the runtime. The agent only decodes the token and does not verify it again.
- **Do not trust `actorId` or `user` in the payload.** Any caller with a valid token can forge the payload. Every decision about "who" and "what they may do" uses the JWT `username`.
- If the identity cannot be obtained, return an `error` event (1.6) and do not continue as an anonymous user.

### 1.4 Output: the streaming event contract

The entry function is an async generator. Each `yield` is a dict, and AgentCore outputs it as `data: <json>` in `text/event-stream`. The bot renders the card from these events (design 6.2):

```jsonc
{"type": "text",       "delta": "..."}                    // body increment
{"type": "reasoning",  "delta": "..."}                    // reasoning increment (shown collapsed)
{"type": "tool_start", "id": "t1", "name": "search", "input": {...}}   // the same id may be sent several times, later ones complete input
{"type": "tool_end",   "id": "t1", "status": "success" | "error", "summary": "first line of the result"}
{"type": "usage",      "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheWriteTokens": 0, "model": "..."}  // incremental, one per model call
{"type": "done"}
{"type": "error",      "code": "...", "message": "..."}
{"type": "interrupt",  ...}                               // see 2.4
```

- **Convert the raw Strands events before yielding** (as the reference template does). The bot also parses raw events from `agent.stream_async()` on a best-effort basis, but events containing an `Agent` object are serialized by the SDK into Python repr strings and can only be dropped (tested).
- Keep each event small (the streaming event limit is 64 KB). For tool results send only a `summary` (the first line, at most 200 characters), not the whole tool output.
- `usage` is incremental and the bot accumulates it. Without `usage`, the footer does not show token counts.
- The bot ignores unknown event types. You can safely add custom debug events, but they are not displayed.

Conversion from Strands events to contract events (`invoke()` in the reference template):

| Strands `stream_async` event | Output |
|---|---|
| `{"data": str}` | `text` |
| `{"reasoning": True, "reasoningText": str}` | `reasoning` |
| `{"current_tool_use": {...}}` (the first time per toolUseId) | `tool_start` (without input) |
| `{"message": {role: assistant, content: [toolUse]}}` | `tool_start` (completes input) |
| `{"message": {content: [toolResult]}}` | `tool_end` |
| `{"event": {"metadata": {"usage": ...}}}` | `usage` |
| End of the loop | `done` |

### 1.5 Sessions and memory

`conversationId` in the payload is the `runtimeSessionId` computed by the bot (`fs-` + 40 hex characters). It stays the same for the same user, the same conversation location (direct message / group / topic), the same agent alias, and the same generation, and it changes after `/new` (design 5.4).

- **Use AgentCore Memory for conversation memory**, keyed by `(actorId, conversationId)`, with actorId taken from the JWT:

  ```python
  AgentCoreMemorySessionManager(
      agentcore_memory_config=AgentCoreMemoryConfig(memory_id=MEMORY_ID, session_id=conversation_id, actor_id=actor_id),
      region_name=REGION)
  ```

  After the microVM is reclaimed (15 minutes idle), calling again with the same session starts a new microVM, and Memory restores the history (tested). History kept only in memory is lost.
- **The in-process cache must be separated by `(actorId, conversationId)`** (the `_agents` dict in the reference template). Do not keep state such as "the current user" in a global variable.
- **Do not assume a microVM belongs to a single user.** AgentCore does not bind a runtime session to the caller's identity: another valid token can enter the same microVM with the same session ID (tested). The bot never calls like that, but the agent's isolation must not depend on it.
- **In group chats every person has their own session.** The agent cannot see other people's conversations with it in the same group, so do not assume "everybody shares the context" when replying.

### 1.6 Error handling

- **Return HTTP 200 even on errors**: `yield {"type":"error","code":"...","message":"..."}` in the stream and then finish. AgentCore wraps a non-2xx response into a generic error and discards the content (design 6.3).
- `message` is not shown to users (the card shows only an error code and a generic explanation), but it is available for troubleshooting through the bot's logs, so **do not put sensitive information in it**.
- After an error, clear that user's in-process Agent cache so the next turn reloads from Memory and corrupted state does not persist.
- There are no stop semantics: the bot does not cancel a turn midway (design 7.4), and each turn ends by its own logic and the bot's timeout. Do not write tool calls that loop forever.

### 1.7 Execution role permissions

On top of the usual permissions (model invocation, logs, X-Ray, reading the code package, Memory), **explicitly deny** (design 5.3, template [`deploy/execution-role-extra-policy.json`](../examples/strands-agent/deploy/execution-role-extra-policy.json)):

- `bedrock-agentcore:GetWorkloadAccessTokenForUserId` and `GetWorkloadAccessTokenForJWT`: prevents the agent from impersonating other users.
- `cognito-idp:*`: the ability to mint tokens exists only on the bot host.

### 1.8 Output content: fit Feishu cards

The reply is rendered as markdown in a Feishu Card 2.0 (design 7.3).

- Supported: headings, lists, bold / italic, links, code blocks, and tables (at most 5 tables per card; extras are turned into code blocks).
- External images `![](https://...)` are turned into links (a card can only show images uploaded to Feishu).
- Do not output HTML. Feishu extension tags such as `<at …>` are neutralized, so the agent cannot @-mention people.
- One card holds about 28 KB. Longer replies are truncated and the full content is sent as a separate `.md` file, so put the conclusion first so the key points remain visible when truncated.
- The card summary (shown in the conversation list) is the first 50 characters of the reply.

### 1.9 Full payload fields

```jsonc
{
  "prompt": "...",                                   // the user's message text (a quoted reply is prefixed with "> quoted content")
  "images": [{ "mimeType": "image/png", "dataBase64": "..." }],     // optional, 2.1
  "files": [{ "name": "...", "mimeType": "...", "sizeBytes": 0, "dataBase64": "..." }],  // optional, 2.2
  "actorId": "feishu:<tenant_key>:<union_id>",       // for reference only, the JWT is authoritative
  "conversationId": "fs-…",                          // = runtimeSessionId, the session_id for Memory
  "turnId": "…",                                     // ID of this turn, for log correlation
  "user": { "name": "..." },                         // optional, 2.3, used only to address the user
  "chat": { "chatType": "p2p" | "group", "chatId": "oc_…", "threadId": "omt_…" },
  "resume": { "interruptId": "...", "value": "..." } // optional, 2.4
}
```

Unknown fields can simply be ignored, and the call does not fail.

---

## 2. Special capabilities

### 2.1 Images

The bot downloads the images in the user's message and puts them into `images` (at most 5, each <= 10 MB, <= 20 MB in total). Convert them to Strands image content blocks:

```python
blocks = [{"image": {"format": mime.split("/")[-1].replace("jpg", "jpeg"),
                     "source": {"bytes": base64.b64decode(img["dataBase64"])}}} for img in images]
blocks.append({"text": prompt or "Please describe this image."})
agent.stream_async(blocks)
```

### 2.2 Files (design 6.4)

The bot inlines files in `files` (each <= 20 MB, <= 50 MB per turn, at most 5 per turn). When only files are sent with no text, the prompt is "The user uploaded files: <name> (<size>)".

- **Handling in the current turn:**
  - PDF, DOC/DOCX, XLS/XLSX, CSV, HTML, TXT, MD and <= about 4.5 MB → a Strands `document` content block.
  - Other text → decode to text and put it in the prompt, truncated if too long.
  - Other formats, or over the limit → save to disk and tell the model to read it with a tool.
- **The `name` of a document block must be unique within the whole conversation.** Bedrock rejects requests whose history contains a document with a duplicate name, and since the history is already stored in Memory, **every later turn of that conversation fails** (tested). Add a random suffix every time you generate a document block, for example `plan [3f9a1c2e]`. A name may contain only letters, digits, single spaces, and `-()[]`.
- **Referring to files across turns.** Write the file into this session's storage (`uploads/<sanitized file name>`) and provide tools to list and read uploaded files.
  - Session storage must be enabled on the runtime: `filesystemConfigurations: [{"sessionStorage": {"mountPath": "/mnt/afb"}}]` (`deploy.py --session-storage /mnt/afb`). The path must be one directory level under `/mnt`, and it is kept across microVMs (tested).
  - Without session storage you can only write to the microVM's local disk (such as `/tmp`), and the files are gone once the microVM is reclaimed after 15 minutes idle.
- **Size.** A payload of about 40 MB was tested and works. The bot-side limits are 20 MB per file and 50 MB per turn.
- **Security.** Sanitize file names first (remove path separators and control characters), and **never execute files uploaded by users**.

### 2.3 Knowing the Feishu identity: prompt design (design 6.1.1)

By default the model does not know who the user is (the JWT reaches the code, not the model). To have the model address the user or personalize answers:

```python
def system_prompt_for(user_name: str | None) -> str:
    return f"""{BASE_SYSTEM_PROMPT}

Current user: {user_name or "unknown"}
(The user's identity has been verified by the system. You may use this name to address the user. Never reveal any internal identifier to the user.)"""
```

- `user_name` comes from `user.name` in the payload and is **used only to address the user, never for authorization**.
- **Do not put union_id / userKey in the prompt.** The model may say them in a reply, or be tricked by prompt injection into using them to impersonate someone.
- For tools that need the user ID, inject it from the JWT in code and do not let the model fill it in:

  ```python
  def make_tools(actor_id: str):
      @tool
      def my_orders() -> str:
          """Look up the current user's orders."""
          return query_orders(owner=actor_id)      # actor_id comes from the JWT, not from a model argument
      return [my_orders]
  ```

- Agent objects are cached by `(actorId, conversationId)`, so the system prompt is not shared between users. When the name changes, rebuild the Agent or update `agent.system_prompt`.

### 2.4 Human confirmation (design 6.5)

Before running a sensitive tool, ask the user to confirm with a button. **Every step is a separate call**: this turn is interrupted and ends → the user clicks a button → the bot sends `resume` on the same session → the agent continues from the interrupt. The agent does not wait for the user inside one stream.

**(1) Declare the tools that need confirmation with a Strands interrupt**

```python
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

NEED_APPROVAL = {"delete_records": "Delete these records?"}

class ApprovalHook(HookProvider):
    def register_hooks(self, registry: HookRegistry, **kwargs):
        registry.add_callback(BeforeToolCallEvent, self.approve)

    def approve(self, event: BeforeToolCallEvent):
        name = event.tool_use["name"]
        if name not in NEED_APPROVAL:
            return
        answer = event.interrupt(f"approve_{name}", reason={
            "title": NEED_APPROVAL[name],
            "detail": json.dumps(event.tool_use.get("input", {}), ensure_ascii=False)[:500],
            "options": [{"label": "Confirm", "value": "yes"}, {"label": "Cancel", "value": "no"}],
        })
        if answer != "yes":
            event.cancel_tool = "The user cancelled the operation"
```

**(2) When the turn ends because of an interrupt, send an `interrupt` event**

```python
async for ev in agent.stream_async(prompt_or_responses):
    ...                                   # convert the events in 1.4 as usual
    if "result" in ev and ev["result"].stop_reason == "interrupt":
        it = ev["result"].interrupts[0]   # the bot renders only the first one each time
        r = it.reason or {}
        yield {"type": "interrupt", "id": it.id, "name": it.name,
               "title": r.get("title", "Confirmation required"), "detail": r.get("detail", ""),
               "options": r.get("options", [{"label": "Confirm", "value": "yes"}, {"label": "Cancel", "value": "no"}])}
yield {"type": "done"}
```

**(3) Resume when `resume` is received**

```python
if payload.get("resume"):
    r = payload["resume"]
    agent_input = [{"interruptResponse": {"interruptId": r["interruptId"], "response": r["value"]}}]
else:
    agent_input = build_prompt(payload)
```

- Do not parse or construct `interrupt.id` yourself. Hand it to the bot as it is and take it back as it is.
- At most 5 options. `label` is shown on the button, and `value` is passed back to the agent.
- The user may click much later: interrupt state is kept across microVMs by `AgentCoreMemorySessionManager` (tested). On an unknown or already-handled `resume`, reply "the confirmation has expired, please start again" and do not raise an error.
- **The system prompt must say** "for operations that need user confirmation, call the corresponding tool directly and do not ask for confirmation in text first; the system will show confirmation buttons automatically". Otherwise the model first asks in text "please reply to confirm" and never calls the tool, so no confirmation button appears (tested).
- If the user sends an ordinary message (without `resume`) while waiting for confirmation, the reference approach is to abandon the unanswered interrupt and handle the new message.
- The bot already guarantees that only the asker can click, that one interrupt is accepted only once, and that old buttons become invalid after the conversation changes. The agent should still run tools under the JWT identity.

### 2.5 Switching between agents

One bot can be bound to several agents, and an administrator switches with `/agent <alias>` (design 8). Each agent keeps its own current conversation at each conversation location, and the alias is part of `conversationId`, so:

- Several agents **can share one Memory resource** without mixing history.
- When switching back to an agent, its last `conversationId` is used, so an agent connected to Memory can continue the conversation.

### 2.6 Groups and topics

- `chat.chatType` is `group` for messages that @-mention the bot in a group, and `chat.threadId` has a value when the message is in a topic.
- Every person has their own session at each location (1.5). The agent must not try to read or refer to other people's conversations in the group.
- Replies appear in the group where everyone can see them. Do not output information in a reply that only the asker should see, or agree in the prompt that "sensitive content should be handled by guiding the user to a direct message".

### 2.7 Third-party OAuth (3LO): not supported for now

3LO in AgentCore Identity requires the application to provide a **public HTTPS callback endpoint**, confirm that "the person who completed the authorization is the one who started it", and then call `CompleteResourceTokenAuth` ([official description](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/oauth2-authorization-url-session-binding.html)). The bot has no inbound ports today, so this needs a separate security design. Until then, do not put tools that require the user to authorize a third-party account into an agent used by the Feishu bot.

---

## 3. Deployment and pre-launch checks

```bash
# Deploy / update (direct code deployment, arm64 zip)
uv run --with boto3 python examples/strands-agent/deploy/deploy.py --region <region> --name <runtime name> --memory \
    [--env KEY=VALUE ...] [--authorizer-json <JSON containing the authorizer configuration>]
```

Confirm each item before going live:

| # | Check | How |
|---|---|---|
| 1 | The execution role has the explicit denies (1.7) | IAM policy simulation: `GetWorkloadAccessTokenForJWT` is explicitDeny |
| 2 | Anonymous and forged tokens are rejected | Call `/invocations` without or with a fake `Authorization`; it should return 401 |
| 3 | The event format is correct | Call `/invocations` with a valid access token and `Accept: text/event-stream`, and check that the stream contains text / tool / usage / done events |
| 4 | Identity comes from the JWT | Call the same session with tokens of two different users; their memories must not be visible to each other |
| 5 | Memory survives across microVMs | Run `StopRuntimeSession` between two turns; the third turn can still continue |
| 6 | Errors return 200 + an error event | Make a tool raise an exception and confirm the stream has an `error` event and HTTP 200 |
| 7 | The binding is ready | `bind --verify` on the host shows "ready", and `/agent` lists it in Feishu |

Recorded samples can be put into `test/fixtures/` and used for regression with the bot's normalization code (`test/fixtures.test.ts`).

---

## 4. Code skeleton

```python
"""<Your agent>: works with the Feishu/Lark bot."""
import base64, json, logging, os
from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool

app = BedrockAgentCoreApp()
log = logging.getLogger("agent")
MEMORY_ID = os.environ.get("AGENTCORE_MEMORY_ID", "")
REGION = os.environ.get("AWS_REGION")
MODEL_ID = os.environ["MODEL_ID"]
BASE_SYSTEM_PROMPT = "……"

_agents: dict[tuple[str, str], Agent] = {}          # cached by (actorId, conversationId) (1.5)

def get_agent(actor_id: str, conversation_id: str, user_name: str | None) -> Agent:
    key = (actor_id, conversation_id)
    if key not in _agents:
        kwargs = {}
        if MEMORY_ID:                                  # 1.5 conversation memory
            from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
            from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager
            kwargs["session_manager"] = AgentCoreMemorySessionManager(
                agentcore_memory_config=AgentCoreMemoryConfig(memory_id=MEMORY_ID, session_id=conversation_id, actor_id=actor_id),
                region_name=REGION)
        _agents[key] = Agent(model=MODEL_ID,
                             system_prompt=system_prompt_for(user_name),     # 2.3
                             tools=make_tools(actor_id),                     # 2.3 tools that need the user ID get it from the JWT
                             hooks=[ApprovalHook()],                         # 2.4
                             callback_handler=None, **kwargs)
    return _agents[key]

@app.entrypoint
async def invoke(payload: dict, context: RequestContext):
    try:
        actor_id = actor_from_jwt(context)                                    # 1.3 trust only the JWT
    except AuthError:
        yield {"type": "error", "code": "UNAUTHENTICATED", "message": "unauthenticated"}
        return
    conversation_id = payload.get("conversationId") or context.session_id
    user_name = (payload.get("user") or {}).get("name")                       # used only to address the user
    try:
        agent = get_agent(actor_id, conversation_id, user_name)
        agent_input = resume_input(payload) if payload.get("resume") else build_prompt(payload)  # 2.4 / 2.1 / 2.2
        async for out in convert(agent.stream_async(agent_input)):            # 1.4 event conversion, including interrupt
            yield out
        yield {"type": "done"}
    except Exception:
        log.exception("turn failed")                                         # 1.6 still return 200 on errors
        _agents.pop((actor_id, conversation_id), None)
        yield {"type": "error", "code": "AGENT_ERROR", "message": "agent error"}

if __name__ == "__main__":
    app.run()
```

For the full implementation of `actor_from_jwt`, `build_prompt`, and the event conversion, see [`examples/strands-agent/agent.py`](../examples/strands-agent/agent.py). For `system_prompt_for`, `make_tools`, `ApprovalHook`, and `resume_input`, see 2.3 and 2.4 in this document.
