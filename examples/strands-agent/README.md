# Reference agent (Strands)

A Strands agent template for the Feishu/Lark bot in this sample. It emits streaming events following the bot's event contract (layer 1 in section 6.2 of the design document). When developing your own agent, read the [agent development guide](../../docs/agent-guide.md) first.

| Capability | Implementation |
|---|---|
| Streaming events | `agent.stream_async()` → `text` / `reasoning` / `tool_start` / `tool_end` / `usage` / `done` / `error` |
| Errors | Still returns HTTP 200 and sends `error` in the stream before finishing |
| Identity | Trusts only the `Authorization` header (a Cognito access token) forwarded by the runtime, and takes `username` as the actorId; the payload is not trusted |
| Memory | Uses AgentCore Memory once `AGENTCORE_MEMORY_ID` is set, stored by `(actorId, conversationId)` |

## Deploy

1. Deploy the bot host (`npm run deploy` in the repository root) and note the `UserPoolId` in the output.
2. Create a Memory (optional): run `agentcore add memory --name FeishuBotMemory` and then `agentcore deploy`, and note the memory id.
3. Deploy this directory as a runtime with the AgentCore CLI (Python, HTTP protocol), with these environment variables:
   - `AGENTCORE_MEMORY_ID`: the memory id from the previous step (conversation memory is not stored if unset)
   - `MODEL_ID`: a Bedrock model ID or inference profile ID; change it to a model available in your account
4. On the host run `agentcore-chat-bridge setup` (or `bind`). It prints the authorizer configuration this runtime needs, shaped like [`deploy/runtime-auth.json`](deploy/runtime-auth.json). Apply it with `UpdateAgentRuntime` (or the CLI options `--authorizer-type CUSTOM_JWT --authorizer-configuration … --request-header-allowlist Authorization`).
   > JWT and IAM authorization are mutually exclusive: after switching to JWT the runtime no longer accepts SigV4 calls. If other programs still call it with IAM, create a separate runtime from the same image.
5. Add [`deploy/execution-role-extra-policy.json`](deploy/execution-role-extra-policy.json) to the execution role. It explicitly denies `GetWorkloadAccessTokenForUserId` / `ForJWT` and all Cognito actions, so the agent cannot impersonate other users (design 5.3). This sample has not tested outbound 3LO authorization with this deny in place.
6. On the host run `agentcore-chat-bridge bind --verify <appId>`. Once the state is ready you can chat in Feishu.
