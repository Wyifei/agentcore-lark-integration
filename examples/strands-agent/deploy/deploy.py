# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0
"""
Deploy the reference agent to AgentCore Runtime (direct code deployment, arm64 zip).

    uv run --with boto3 python examples/strands-agent/deploy/deploy.py --region ap-northeast-1 [--name afb_reference_agent]
        [--memory] [--env KEY=VALUE ...] [--authorizer-json deploy/runtime-auth.json]

Creates or reuses: the code bucket afb-agent-code-<account>-<region> (private), the execution role afb-agent-<name> (explicitly denies impersonating other users),
an optional AgentCore Memory, and the runtime. Without --authorizer-json the runtime uses IAM authorization (switch it to JWT afterwards with the configuration printed by bind).
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import zipfile

import boto3
from botocore.exceptions import ClientError, WaiterError
from botocore.waiter import WaiterModel, create_waiter_with_client

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent


def build_zip(out: pathlib.Path) -> pathlib.Path:
    pkg = out / "package"
    if pkg.exists():
        shutil.rmtree(pkg)
    if shutil.which("uv") is None:
        sys.exit("uv not found on PATH: https://docs.astral.sh/uv/")
    # Fixed argv (no shell); every argument is a constant or a path derived from this script.
    subprocess.run(  # nosec B603
        ["uv", "pip", "install", "--python-platform", "aarch64-manylinux2014", "--python-version", "3.13",
         "--target", str(pkg), "--only-binary=:all:", "-q", "-r", str(SRC / "requirements.txt")],
        check=True,
    )
    shutil.copy(SRC / "agent.py", pkg / "agent.py")
    z = out / "deployment_package.zip"
    with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in sorted(pkg.rglob("*")):
            if "__pycache__" in f.parts:
                continue
            info = zipfile.ZipInfo(str(f.relative_to(pkg)) + ("/" if f.is_dir() else ""))
            info.external_attr = ((0o755 if f.is_dir() or f.stat().st_mode & 0o111 else 0o644) << 16)
            if f.is_dir():
                zf.writestr(info, "")
            else:
                info.compress_type = zipfile.ZIP_DEFLATED
                zf.writestr(info, f.read_bytes())
    print(f"zip: {z} ({z.stat().st_size // 1024 // 1024} MB)")
    return z


def runtime_waiter(ctl):
    """Waits until the runtime leaves CREATING / UPDATING (boto3 has no built-in waiter for runtimes)."""
    model = WaiterModel({"version": 2, "waiters": {"RuntimeSettled": {
        "operation": "GetAgentRuntime", "delay": 10, "maxAttempts": 90,
        "acceptors": [
            {"matcher": "path", "argument": "status", "expected": "READY", "state": "success"},
            {"matcher": "path", "argument": "status", "expected": "CREATE_FAILED", "state": "failure"},
            {"matcher": "path", "argument": "status", "expected": "UPDATE_FAILED", "state": "failure"},
        ]}}})
    return create_waiter_with_client("RuntimeSettled", model, ctl)


def ensure_bucket(s3, name, region, account):
    try:
        s3.head_bucket(Bucket=name, ExpectedBucketOwner=account)
        return
    except ClientError as e:
        if e.response["Error"]["Code"] not in ("404", "NoSuchBucket"):
            raise
    s3.create_bucket(Bucket=name, CreateBucketConfiguration={"LocationConstraint": region})
    s3.put_public_access_block(Bucket=name, PublicAccessBlockConfiguration={
        "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
    print(f"created bucket {name}")


def ensure_role(iam, name, region, account, bucket, memory_arn):
    trust = {"Version": "2012-10-17", "Statement": [{
        "Effect": "Allow", "Principal": {"Service": "bedrock-agentcore.amazonaws.com"}, "Action": "sts:AssumeRole",
        "Condition": {"StringEquals": {"aws:SourceAccount": account},
                      "ArnLike": {"aws:SourceArn": f"arn:aws:bedrock-agentcore:{region}:{account}:*"}}}]}
    try:
        arn = iam.get_role(RoleName=name)["Role"]["Arn"]
    except ClientError:
        arn = iam.create_role(RoleName=name, AssumeRolePolicyDocument=json.dumps(trust),
                              Description="afb reference agent execution role")["Role"]["Arn"]
        iam.get_waiter("role_exists").wait(RoleName=name)
        print(f"created role {name}")
    stmts = [
        {"Sid": "Models", "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
         "Resource": ["arn:aws:bedrock:*::foundation-model/*", f"arn:aws:bedrock:*:{account}:inference-profile/*"]},
        {"Sid": "Code", "Effect": "Allow", "Action": ["s3:GetObject"], "Resource": f"arn:aws:s3:::{bucket}/*"},
        {"Sid": "Logs", "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents",
                                                     "logs:DescribeLogStreams", "logs:DescribeLogGroups"],
         "Resource": f"arn:aws:logs:{region}:{account}:log-group:/aws/bedrock-agentcore/*"},
        # These X-Ray actions have no resource types, so the Service Authorization Reference requires Resource "*"
        {"Sid": "Traces", "Effect": "Allow", "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords",
                                                       "xray:GetSamplingRules", "xray:GetSamplingTargets"],
         "Resource": "*"},
        # PutMetricData is scoped by namespace instead of by resource
        {"Sid": "Metrics", "Effect": "Allow", "Action": ["cloudwatch:PutMetricData"], "Resource": "*",
         "Condition": {"StringEquals": {"cloudwatch:namespace": "bedrock-agentcore"}}},
        {"Sid": "WorkloadToken", "Effect": "Allow", "Action": ["bedrock-agentcore:GetWorkloadAccessToken"],
         "Resource": f"arn:aws:bedrock-agentcore:{region}:{account}:workload-identity-directory/default/*"},
        # Design 5.3: the agent must not impersonate other users
        {"Sid": "DenyImpersonation", "Effect": "Deny",
         "Action": ["bedrock-agentcore:GetWorkloadAccessTokenForUserId", "bedrock-agentcore:GetWorkloadAccessTokenForJWT"],
         "Resource": "*"},
        {"Sid": "DenyCognito", "Effect": "Deny", "Action": "cognito-idp:*", "Resource": "*"},
    ]
    if memory_arn:
        stmts.append({"Sid": "Memory", "Effect": "Allow", "Action": [
            "bedrock-agentcore:CreateEvent", "bedrock-agentcore:ListEvents", "bedrock-agentcore:GetEvent",
            "bedrock-agentcore:ListSessions", "bedrock-agentcore:RetrieveMemoryRecords", "bedrock-agentcore:ListMemoryRecords"],
            "Resource": memory_arn})
    iam.put_role_policy(RoleName=name, PolicyName="agent", PolicyDocument=json.dumps({"Version": "2012-10-17", "Statement": stmts}))
    return arn


def ensure_memory(ctl, name):
    for m in ctl.list_memories().get("memories", []):
        if m.get("id", "").startswith(name + "-"):
            return m["id"], m["arn"]
    r = ctl.create_memory(name=name, description="afb reference agent short-term memory", eventExpiryDuration=30)
    mid = r["memory"]["id"]
    print(f"creating memory {mid} ...")
    try:
        ctl.get_waiter("memory_created").wait(memoryId=mid, WaiterConfig={"Delay": 10, "MaxAttempts": 60})
    except WaiterError as e:
        sys.exit(f"memory creation failed: {e}")
    return mid, r["memory"]["arn"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--region", required=True)
    ap.add_argument("--name", default="afb_reference_agent")
    ap.add_argument("--memory", action="store_true", help="create/reuse an AgentCore Memory and inject AGENTCORE_MEMORY_ID")
    ap.add_argument("--env", action="append", default=[], help="KEY=VALUE")
    ap.add_argument("--authorizer-json", help="JSON file containing authorizerConfiguration / requestHeaderConfiguration")
    ap.add_argument("--skip-build", action="store_true")
    ap.add_argument("--session-storage", help="session storage mount point, for example /mnt/afb (keeps uploaded files across microVMs, design 6.4)")
    a = ap.parse_args()

    sess = boto3.Session(region_name=a.region)
    account = sess.client("sts").get_caller_identity()["Account"]
    s3, iam, ctl = sess.client("s3"), sess.client("iam"), sess.client("bedrock-agentcore-control")
    bucket = f"afb-agent-code-{account}-{a.region}"
    ensure_bucket(s3, bucket, a.region, account)

    env = dict(kv.split("=", 1) for kv in a.env)
    memory_arn = None
    if a.memory:
        mid, memory_arn = ensure_memory(ctl, "afb_reference_memory")
        env["AGENTCORE_MEMORY_ID"] = mid
    role = ensure_role(iam, f"afb-agent-{a.name}"[:64], a.region, account, bucket, memory_arn)

    out = HERE / ".build"  # kept between runs so --skip-build can reuse the last package (gitignored)
    out.mkdir(exist_ok=True)
    z = out / "deployment_package.zip" if a.skip_build else build_zip(out)
    key = f"{a.name}/deployment_package.zip"
    s3.upload_file(str(z), bucket, key, ExtraArgs={"ExpectedBucketOwner": account})

    kwargs = dict(
        agentRuntimeArtifact={"codeConfiguration": {
            "code": {"s3": {"bucket": bucket, "prefix": key}},
            "runtime": "PYTHON_3_13",
            "entryPoint": ["opentelemetry-instrument", "agent.py"]}},
        networkConfiguration={"networkMode": "PUBLIC"},
        roleArn=role,
        environmentVariables=env or None,
    )
    if a.session_storage:
        kwargs["filesystemConfigurations"] = [{"sessionStorage": {"mountPath": a.session_storage}}]
        env["SESSION_STORAGE_PATH"] = a.session_storage
        kwargs["environmentVariables"] = env
    if a.authorizer_json:
        cfg = json.loads(pathlib.Path(a.authorizer_json).read_text())
        kwargs["authorizerConfiguration"] = cfg["authorizerConfiguration"]
        kwargs["requestHeaderConfiguration"] = cfg["requestHeaderConfiguration"]
    kwargs = {k: v for k, v in kwargs.items() if v is not None}

    runtimes, token = [], None
    while True:  # ListAgentRuntimes pagination
        page = ctl.list_agent_runtimes(**({"nextToken": token} if token else {}))
        runtimes += page["agentRuntimes"]
        token = page.get("nextToken")
        if not token:
            break
    existing = next((r for r in runtimes if r["agentRuntimeName"] == a.name), None)
    try:
        if existing:
            r = ctl.update_agent_runtime(agentRuntimeId=existing["agentRuntimeId"], **kwargs)
        else:
            r = ctl.create_agent_runtime(agentRuntimeName=a.name, **kwargs)
    except ClientError as e:
        if "role" in str(e).lower():
            sys.exit(f"{e}\nA newly created IAM role can take a few seconds to become usable; run the command again.")
        raise
    rid = r["agentRuntimeId"]
    try:
        runtime_waiter(ctl).wait(agentRuntimeId=rid)
    except WaiterError as e:
        print(f"runtime did not become READY: {e}", file=sys.stderr)  # the status and failureReason follow
    st = ctl.get_agent_runtime(agentRuntimeId=rid)
    print(json.dumps({"arn": st["agentRuntimeArn"], "status": st["status"], "version": st["agentRuntimeVersion"],
                      "failureReason": st.get("failureReason")}, ensure_ascii=False))


if __name__ == "__main__":
    main()
