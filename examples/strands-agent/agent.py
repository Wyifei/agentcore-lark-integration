# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Reference agent: Strands Agents + AgentCore Runtime (design 5.3, 5.4, 6).

- The entry point reads raw Strands events with agent.stream_async() and converts them to the bot's layer-1 event contract before yielding:
    text / reasoning / tool_start / tool_end / usage / done / error
- Errors still return HTTP 200: send an error event in the stream and then finish (AgentCore discards the body of non-2xx responses).
- Identity comes only from the JWT: take the access token from the Authorization header in context.request_headers
  and use its username (= userKey) as the actorId. The runtime has already verified the token, so it is only decoded here, not verified.
  **Do not trust** actorId in the payload.
- Conversation memory: AgentCore Memory, stored and loaded by (actorId, conversationId), so a conversation continues after the microVM is reclaimed.
"""
import base64
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from bedrock_agentcore.runtime import BedrockAgentCoreApp, RequestContext
from strands import Agent, tool
from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

log = logging.getLogger("agent")
app = BedrockAgentCoreApp()

MEMORY_ID = os.environ.get("AGENTCORE_MEMORY_ID", "")
REGION = os.environ.get("AWS_REGION", "us-west-2")
MODEL_ID = os.environ.get("MODEL_ID", "global.anthropic.claude-sonnet-5-5")
SYSTEM_PROMPT = os.environ.get("SYSTEM_PROMPT", "你是一个乐于助人的助手，用简洁的中文回答。")
MAX_SUMMARY = 200  # Send only a summary of tool results; a single streaming event must stay under 64 KB
# For testing: with RAW_EVENTS=1, yield the raw Strands events as they are (simulates a customer agent that does not use this template)
RAW_EVENTS = os.environ.get("RAW_EVENTS") == "1"

# Files (design 6.4): mount point of session storage (deploy.py --session-storage /mnt/afb), kept across microVMs; falls back to /tmp when absent (valid only in this microVM)
SESSION_MOUNT = os.environ.get("SESSION_STORAGE_PATH", "/mnt/afb")
UPLOAD_DIR = Path(SESSION_MOUNT if os.path.isdir(SESSION_MOUNT) else "/tmp/afb") / "uploads"
DOC_FORMATS = {"pdf", "csv", "doc", "docx", "xls", "xlsx", "html", "txt", "md"}
DOC_MAX_BYTES = 4_500_000           # Size limit of a Bedrock document block (about 4.5 MB)
TEXT_MAX_CHARS = 100_000
TEXT_EXTS = {"txt", "md", "csv", "json", "xml", "yaml", "yml", "log", "py", "js", "ts", "java", "go", "sql", "sh", "html", "htm", "ini", "toml"}


class AuthError(Exception):
    pass


def actor_from_jwt(context: RequestContext) -> str:
    """Take the username from the Authorization header forwarded by the runtime. The runtime has already verified the signature and client_id."""
    headers = {k.lower(): v for k, v in (context.request_headers or {}).items()}
    auth = headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise AuthError("missing bearer token (runtime 需要在 requestHeaderAllowlist 放行 Authorization)")
    parts = auth.split(" ", 1)[1].split(".")
    if len(parts) != 3:
        raise AuthError("malformed token")
    payload = json.loads(base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)))
    if payload.get("token_use") != "access":
        raise AuthError("not an access token")
    username = payload.get("username")
    if not username:
        raise AuthError("token has no username")
    return username


@tool
def current_time() -> str:
    """Return the current UTC time (ISO 8601)."""
    return datetime.now(timezone.utc).isoformat()


def safe_filename(name: str) -> str:
    """Sanitize an uploaded file name: remove paths and control characters so nothing is written outside the uploads directory."""
    base = os.path.basename(name.replace("\\", "/")).strip().lstrip(".")
    base = re.sub(r"[\x00-\x1f/]", "_", base)[:120]
    return base or "file"


def doc_name(name: str) -> str:
    """Name of a Bedrock document block: only letters, digits, single spaces, and -()[] are allowed, and it **must not repeat within the whole conversation**
    (otherwise every later turn of that conversation fails with ValidationException, tested). So a random suffix is added every time."""
    stem = os.path.splitext(name)[0]
    cleaned = re.sub(r"\s+", " ", re.sub(r"[^A-Za-z0-9\s\-\(\)\[\]]", "-", stem)).strip(" -")
    return f"{cleaned[:50] or 'document'} [{uuid.uuid4().hex[:8]}]"


def ext_of(name: str) -> str:
    return os.path.splitext(name)[1].lower().lstrip(".")


IMAGE_FORMATS = {"png": "png", "jpg": "jpeg", "jpeg": "jpeg", "gif": "gif", "webp": "webp"}
IMAGE_MAX_BYTES = 3_750_000          # Size limit of a Bedrock image block (about 3.75 MB)


def file_block(name: str, data: bytes) -> dict | None:
    """A form the model can read directly: image / document / text block; returns None if none fits."""
    ext = ext_of(name)
    if ext in IMAGE_FORMATS and len(data) <= IMAGE_MAX_BYTES:
        # When an image arrives as a file attachment (not a Feishu image message), let the model see it directly too
        return {"image": {"format": IMAGE_FORMATS[ext], "source": {"bytes": data}}}
    if ext in DOC_FORMATS and len(data) <= DOC_MAX_BYTES:
        return {"document": {"format": ext, "name": doc_name(name), "source": {"bytes": data}}}
    if ext in TEXT_EXTS:
        text = data.decode("utf-8", errors="replace")
        more = "\n…（内容过长，已截断）" if len(text) > TEXT_MAX_CHARS else ""
        return {"text": f"文件 {name} 的内容：\n```\n{text[:TEXT_MAX_CHARS]}\n```{more}"}
    return None


@tool
def list_uploaded_files() -> str:
    """List the files the user uploaded in this conversation (name and size)."""
    if not UPLOAD_DIR.is_dir():
        return "还没有上传过文件。"
    items = [f"{p.name}（{p.stat().st_size} 字节）" for p in sorted(UPLOAD_DIR.iterdir()) if p.is_file()]
    return "\n".join(items) or "还没有上传过文件。"


@tool
def read_uploaded_file(name: str) -> dict:
    """Read the content of a file the user uploaded earlier. name is a file name returned by list_uploaded_files."""
    path = UPLOAD_DIR / safe_filename(name)
    if not path.is_file():
        return {"status": "error", "content": [{"text": f"找不到文件 {name}"}]}
    block = file_block(path.name, path.read_bytes())
    if block is None:
        return {"status": "error", "content": [{"text": f"{name} 不是能直接读取的格式（{ext_of(name) or '无扩展名'}）"}]}
    return {"status": "success", "content": [block]}


# ---------- Human confirmation (design 6.5) ----------

@tool
def delete_records(names: list[str]) -> str:
    """Delete the records with the given names (a demo; nothing is actually deleted). The user must confirm before it runs."""
    return f"已删除 {len(names)} 条记录：{', '.join(names)}"


# Tools that need user confirmation → confirmation title
NEED_APPROVAL = {"delete_records": "确认删除这些记录？"}
APPROVE, REJECT = "yes", "no"


class ApprovalHook(HookProvider):
    """Before a sensitive tool runs, pause the turn with a Strands interrupt and wait for the user to click a button on the Feishu card (design 6.5)."""

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeToolCallEvent, self.approve)

    def approve(self, event: BeforeToolCallEvent) -> None:
        name = event.tool_use["name"]
        if name not in NEED_APPROVAL:
            return
        answer = event.interrupt(f"approve_{name}", reason={
            "title": NEED_APPROVAL[name],
            "detail": json.dumps(event.tool_use.get("input", {}), ensure_ascii=False)[:500],
            "options": [{"label": "确认", "value": APPROVE}, {"label": "取消", "value": REJECT}],
        })
        if answer != APPROVE:
            event.cancel_tool = "用户取消了这个操作"


def interrupt_event(it) -> dict:
    r = it.reason if isinstance(it.reason, dict) else {}
    return {"type": "interrupt", "id": it.id, "name": it.name,
            "title": r.get("title", "需要确认"), "detail": r.get("detail", ""),
            "options": r.get("options") or [{"label": "确认", "value": APPROVE}, {"label": "取消", "value": REJECT}]}


def pending_interrupts(agent: Agent) -> list:
    state = getattr(agent, "_interrupt_state", None)
    if not state or not state.activated:
        return []
    return [it for it in state.interrupts.values() if it.response is None]


_agents: dict[tuple[str, str], Agent] = {}


def system_prompt_for(user_name: str | None) -> str:
    """Current user (design 6.1.1): the name is used only to address the user; union_id / userKey are not given to the model."""
    return (
        f"{SYSTEM_PROMPT}\n\n"
        # Human confirmation (design 6.5): otherwise the model first asks in text "please reply to confirm", never calls the tool, and the confirmation button is not triggered
        "需要用户确认的操作（例如删除）请直接调用对应工具，不要先用文字征求确认："
        "系统会在执行前自动向用户弹出确认按钮，用户取消时工具不会执行，你会收到取消结果。\n\n"
        f"当前用户：{user_name or '未知'}\n"
        "（用户身份已由系统验证。称呼用户时可以使用这个名字；不要向用户透露任何内部标识。）"
    )


def get_agent(actor_id: str, conversation_id: str, user_name: str | None = None) -> Agent:
    key = (actor_id, conversation_id)
    if key in _agents:
        agent = _agents[key]
        agent.system_prompt = system_prompt_for(user_name)   # Takes effect on the next turn after the user renames themselves
        return agent
    kwargs = {}
    if MEMORY_ID:
        from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig
        from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

        kwargs["session_manager"] = AgentCoreMemorySessionManager(
            agentcore_memory_config=AgentCoreMemoryConfig(
                memory_id=MEMORY_ID, session_id=conversation_id, actor_id=actor_id
            ),
            region_name=REGION,
        )
    agent = Agent(model=MODEL_ID, system_prompt=system_prompt_for(user_name),
                  tools=[current_time, list_uploaded_files, read_uploaded_file, delete_records],
                  hooks=[ApprovalHook()], callback_handler=None, **kwargs)
    _agents[key] = agent
    return agent


def save_files(files: list[dict]) -> list[tuple[str, bytes]]:
    """Write this turn's files into session storage so later turns can read them with read_uploaded_file."""
    saved = []
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    for f in files:
        name = safe_filename(f.get("name") or "file")
        data = base64.b64decode(f.get("dataBase64") or "")
        (UPLOAD_DIR / name).write_bytes(data)
        saved.append((name, data))
    return saved


def build_prompt(payload: dict):
    text = payload.get("prompt") or ""
    images = payload.get("images") or []
    files = payload.get("files") or []
    if not images and not files:
        return text
    blocks = []
    for name, data in save_files(files):
        block = file_block(name, data)
        if block is None:
            blocks.append({"text": f"（用户上传了 {name}，{len(data)} 字节，格式不能直接读取，已保存；不要执行它。）"})
        else:
            blocks.append(block)
    for img in images:
        fmt = (img.get("mimeType") or "image/png").split("/")[-1]
        if fmt == "jpg":
            fmt = "jpeg"
        blocks.append({"image": {"format": fmt, "source": {"bytes": base64.b64decode(img["dataBase64"])}}})
    blocks.append({"text": text or ("请描述这张图片。" if images else "用户上传了文件，请确认收到并简要说明内容。")})
    return blocks


def first_line(s: str) -> str:
    for line in s.splitlines():
        if line.strip():
            return line.strip()[:MAX_SUMMARY]
    return ""


def tool_result_summary(result: dict) -> str:
    for c in result.get("content") or []:
        if isinstance(c, dict) and c.get("text"):
            return first_line(c["text"])
        if isinstance(c, dict) and "json" in c:
            return first_line(json.dumps(c["json"], ensure_ascii=False))
    return ""


@app.entrypoint
async def invoke(payload: dict, context: RequestContext):
    try:
        actor_id = actor_from_jwt(context)
    except AuthError as e:
        log.warning("auth: %s", e)
        yield {"type": "error", "code": "UNAUTHENTICATED", "message": "unauthenticated"}
        return

    conversation_id = payload.get("conversationId") or context.session_id
    try:
        user_name = (payload.get("user") or {}).get("name")   # Used only to address the user, never for authorization
        agent = get_agent(actor_id, conversation_id, user_name if isinstance(user_name, str) else None)
        if RAW_EVENTS:
            async for ev in agent.stream_async(build_prompt(payload)):
                yield ev
            return
        resume = payload.get("resume") if isinstance(payload.get("resume"), dict) else None
        pending = pending_interrupts(agent)
        if resume:
            if not any(it.id == resume.get("interruptId") for it in pending):
                # The interrupt was already handled, was cancelled by a new message, or its state was not kept
                yield {"type": "text", "delta": "这个确认已经过期或处理过了，请重新发起。"}
                yield {"type": "done"}
                return
            agent_input = [{"interruptResponse": {"interruptId": it.id,
                            "response": resume.get("value") if it.id == resume.get("interruptId") else REJECT}} for it in pending]
        else:
            if pending:
                # The user sent an ordinary message while waiting for confirmation: cancel the unanswered interrupt and handle the new message (design 6.5)
                async for _ in agent.stream_async([{"interruptResponse": {"interruptId": it.id, "response": REJECT}} for it in pending]):
                    pass
            agent_input = build_prompt(payload)
        started: set[str] = set()
        interrupted = None
        async for ev in agent.stream_async(agent_input):
            if "result" in ev and getattr(ev["result"], "stop_reason", None) == "interrupt":
                its = getattr(ev["result"], "interrupts", None) or []
                interrupted = its[0] if its else None    # The bot renders only the first one each time
                continue
            if "data" in ev and isinstance(ev["data"], str):
                yield {"type": "text", "delta": ev["data"]}
            elif ev.get("reasoning") and isinstance(ev.get("reasoningText"), str):
                yield {"type": "reasoning", "delta": ev["reasoningText"]}
            elif "current_tool_use" in ev:
                tu = ev["current_tool_use"] or {}
                tid = tu.get("toolUseId")
                if tid and tid not in started:
                    started.add(tid)
                    yield {"type": "tool_start", "id": tid, "name": tu.get("name", "tool")}
            elif "message" in ev:
                msg = ev["message"] or {}
                for block in msg.get("content") or []:
                    if "toolUse" in block and msg.get("role") == "assistant":
                        tu = block["toolUse"]
                        # Fill in the full input (input is not complete while streaming)
                        yield {"type": "tool_start", "id": tu.get("toolUseId"), "name": tu.get("name"), "input": tu.get("input")}
                    elif "toolResult" in block:
                        tr = block["toolResult"]
                        yield {
                            "type": "tool_end",
                            "id": tr.get("toolUseId"),
                            "status": "error" if tr.get("status") == "error" else "success",
                            "summary": tool_result_summary(tr),
                        }
            elif "event" in ev:
                usage = ((ev["event"] or {}).get("metadata") or {}).get("usage")
                if usage:
                    yield {
                        "type": "usage",
                        "inputTokens": usage.get("inputTokens", 0),
                        "outputTokens": usage.get("outputTokens", 0),
                        "cacheReadTokens": usage.get("cacheReadInputTokens", 0),
                        "cacheWriteTokens": usage.get("cacheWriteInputTokens", 0),
                        "model": MODEL_ID,
                    }
        if interrupted is not None:
            yield interrupt_event(interrupted)
        yield {"type": "done"}
    except Exception:  # Return 200 even on errors and report them in the stream
        log.exception("turn failed")
        _agents.pop((actor_id, conversation_id), None)
        yield {"type": "error", "code": "AGENT_ERROR", "message": "agent error"}


if __name__ == "__main__":
    app.run()
