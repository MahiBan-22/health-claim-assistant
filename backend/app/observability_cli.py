"""Developer-only local metrics and read-only NeatLogs investigation commands."""
import argparse
import json
import os
import statistics
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit
import httpx
from .config import settings

class NeatLogsMCP:
    def __init__(self, config):
        key = config.neatlogs_api_key.get_secret_value()
        if not key:
            raise ValueError("Configure NEATLOGS_API_KEY in .env")
        self.client = httpx.Client(base_url=config.neatlogs_endpoint, timeout=30,
            headers={"Authorization": "Bearer " + key, "Accept": "application/json, text/event-stream"})
        self.sequence = 0
    def __enter__(self):
        try:
            negotiated = self.rpc("initialize", {"protocolVersion":"2025-03-26", "capabilities":{},
                                     "clientInfo":{"name":"claim-evidence-observability", "version":"1.0"}})
            self.client.headers["MCP-Protocol-Version"] = negotiated.get("protocolVersion", "2025-03-26")
            self.rpc("notifications/initialized", notification=True)
            return self
        except BaseException:
            self.client.close()
            raise
    def __exit__(self, *args):
        self.client.close()
    def rpc(self, method, params=None, notification=False):
        self.sequence += 1
        body = {"jsonrpc":"2.0", "method":method}
        if params is not None: body["params"] = params
        if not notification: body["id"] = self.sequence
        response = self.client.post("/mcp", json=body)
        response.raise_for_status()
        if response.headers.get("mcp-session-id"):
            self.client.headers["mcp-session-id"] = response.headers["mcp-session-id"]
        if notification or response.status_code == 202: return {}
        if "text/event-stream" in response.headers.get("content-type", ""):
            messages = [json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith("data:")]
            data = next(item for item in messages if item.get("id") == self.sequence)
        else:
            data = response.json()
        if data.get("error"): raise RuntimeError("NeatLogs MCP request failed")
        return data.get("result", {})
    def tool(self, name, **arguments):
        allowed = {"ping", "whoami", "search_traces", "get_trace_context", "list_detections", "triage_list"}
        if name not in allowed: raise ValueError("Read-only investigation tool required")
        result = self.rpc("tools/call", {"name":name, "arguments":arguments})
        if result.get("isError"): raise RuntimeError("NeatLogs tool unavailable or not authorized")
        if result.get("structuredContent") is not None: return result["structuredContent"]
        texts = [item["text"] for item in result.get("content", []) if item.get("type") == "text"]
        return json.loads("\n".join(texts)) if texts else result

def read_trace(mcp, trace_id):
    data = mcp.tool("get_trace_context", trace_id=trace_id, limit=200)
    if "spans" not in data: return data
    spans = list(data["spans"])
    offset = data.get("next_offset")
    pages = 1
    while offset is not None and pages < 50:
        page = mcp.tool("get_trace_context", trace_id=trace_id, limit=200, offset=offset,
                        **({"context_revision":data["context_revision"]} if data.get("context_revision") else {}))
        spans.extend(page.get("spans", []))
        following = page.get("next_offset")
        if following is not None and following <= offset: raise RuntimeError("Invalid trace pagination")
        offset, pages = following, pages + 1
    data["spans"] = spans
    data["retrieved_span_count"] = len(spans)
    data["all_spans_retrieved"] = offset is None and len({s["span_id"] for s in spans}) == data.get("span_count",len(spans))
    return data

def percentile(values, fraction):
    values = sorted(values)
    return round(values[min(len(values)-1, max(0, int((len(values)-1)*fraction)))], 2) if values else None

def local_summary(config, run_id=None):
    spans, degraded = [], 0
    for path in config.log_dir.glob("telemetry-*.jsonl*"):
        for line in path.read_text(encoding="utf-8").splitlines():
            try: item = json.loads(line)
            except ValueError: continue
            attrs = item.get("attributes", {})
            if run_id and attrs.get("claim.run_id") != run_id: continue
            if item.get("event") == "telemetry_degraded": degraded += 1
            elif item.get("event") == "span": spans.append(item)
    diagnostic_count = sum(item["attributes"].get("claim.synthetic") is True for item in spans)
    spans = [item for item in spans if item["attributes"].get("claim.synthetic") is not True]
    roots = [item for item in spans if item["name"] == "claim.analysis"]
    models = [item for item in spans if item["kind"] == "LLM"]
    durations = [item["attributes"].get("claim.duration_ms", 0) for item in roots]
    return {"scope":"retained local rotating logs", "analysis_attempts":len(roots),
        "completed":sum(item["attributes"].get("claim.analysis_status") == "completed" for item in roots),
        "paused":sum(item["attributes"].get("claim.analysis_status") == "paused" for item in roots),
        "duration_p50_ms":percentile(durations,.5), "duration_p95_ms":percentile(durations,.95),
        "synthetic_spans_excluded":diagnostic_count, "model_calls":len(models), "input_tokens":sum(item["attributes"].get("neatlogs.llm.token_count.prompt",0) for item in models),
        "output_tokens":sum(item["attributes"].get("neatlogs.llm.token_count.completion",0) for item in models),
        "calls_with_usage":sum("neatlogs.llm.token_count.total" in item["attributes"] for item in models),
        "telemetry_degraded_events":degraded, "cost_usd":None,
        "traces":[{"run_id":item["attributes"].get("claim.run_id"), "trace_id":item["trace_id"],
                   "status":item["attributes"].get("claim.analysis_status")} for item in sorted(roots,key=lambda x:x["time"],reverse=True)[:20]]}

def trace_summary(data):
    traces = data.get("traces", data.get("results", []))
    safe = []
    for trace in traces:
        item = {k:trace.get(k) for k in ("trace_id", "name", "status", "created_at", "latency_ms", "cost", "span_count")}
        item["name"] = trace.get("name", trace.get("root_span_name"))
        item["latency_ms"] = trace.get("latency_ms", trace.get("duration_ms"))
        item["cost"] = trace.get("cost", trace.get("cost_usd"))
        url = trace.get("url")
        if isinstance(url,str) and urlsplit(url).scheme == "https" and urlsplit(url).hostname == "neatlogs.com": item["url"] = url
        safe.append(item)
    return {"total_count":data.get("total_count",data.get("total",len(traces))), "has_more":data.get("has_more",False), "traces":safe}

def tree_summary(data):
    def node(span):
        return {**{k:span.get(k) for k in ("span_id", "span_type", "name", "status", "latency_ms")},
                "children":[node(child) for child in span.get("children", [])]}
    if "spans" in data:
        return {**{k:data.get(k) for k in ("trace_id", "status", "finalization_status", "span_count", "root_span_count", "span_tree_complete", "verification_ready", "total_tokens", "total_cost", "retrieved_span_count", "all_spans_retrieved")},
                "spans":[{k:span.get(k) for k in ("span_id", "parent_span_id", "name", "type", "status", "duration_ms")} for span in data["spans"]]}
    return {"trace_id":data.get("trace_id"), "span_count":data.get("span_count"),
            "total_latency_ms":data.get("total_latency_ms"), "total_cost":data.get("total_cost"),
            "root_span":node(data.get("root_span") or {})}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["summary", "search", "trace", "overview", "doctor-local", "doctor-probe"])
    parser.add_argument("--run-id")
    parser.add_argument("--trace-id")
    parser.add_argument("--query", default="claim.analysis")
    args = parser.parse_args()
    config = settings()
    try:
        if args.command.startswith("doctor-"):
            env = dict(os.environ)
            if args.command == "doctor-probe":
                if not config.neatlogs_api_key.get_secret_value(): raise ValueError("Configure NEATLOGS_API_KEY")
                env["NEATLOGS_API_KEY"] = config.neatlogs_api_key.get_secret_value()
                env["NEATLOGS_ENDPOINT"] = config.neatlogs_endpoint
            else: env.pop("NEATLOGS_API_KEY", None)
            result = subprocess.run([sys.executable,"-m","neatlogs","doctor", "--probe" if args.command.endswith("probe") else "--local", "--json"],env=env,timeout=60)
            return result.returncode
        if args.command == "summary": result = local_summary(config,args.run_id)
        else:
            with NeatLogsMCP(config) as mcp:
                mcp.tool("ping")
                identity = mcp.tool("whoami")
                if args.command == "search":
                    result = trace_summary(mcp.tool("search_traces",query=args.run_id or args.query,limit=20))
                elif args.command == "trace":
                    trace_id = args.trace_id
                    if not trace_id:
                        matches = trace_summary(mcp.tool("search_traces",query=args.run_id or args.query,limit=20))["traces"]
                        if not matches: raise ValueError("No matching traces yet")
                        trace_id = max(matches,key=lambda t:str(t.get("created_at") or ""))["trace_id"]
                    result = tree_summary(read_trace(mcp,trace_id))
                else:
                    traces = trace_summary(mcp.tool("search_traces",query=args.query,limit=20))
                    detections = mcp.tool("list_detections",limit=20)
                    fixes = mcp.tool("triage_list",limit=20)
                    result = {"project_id":identity.get("project_id"), "traces":traces,
                        "detections":[{"name":d.get("name",d.get("slug")), "enabled":d.get("enabled",d.get("is_active")), "type":d.get("type"),
                                       "fire_count_24h":d.get("fire_count_24h")} for d in detections.get("detections",[])],
                        "fix_count":fixes.get("total_count",fixes.get("total")), "local":local_summary(config)}
        print(json.dumps(result,indent=2))
        return 0
    except Exception as error:
        # Never dump remote bodies or authentication headers.
        print(json.dumps({"status":"unverified", "error_type":type(error).__name__,
            "next_action":"Check NeatLogs project key, endpoint and connectivity; see docs/observability.md"}))
        return 1

if __name__ == "__main__":
    raise SystemExit(main())
