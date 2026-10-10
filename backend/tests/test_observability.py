import json
from types import SimpleNamespace
import httpx
import pytest
from app import observability as obs
from app.config import Settings

SECRET = "Bearer private-token patient Alice Example alice@example.com Claim C-SECRET"

def test_mask_removes_content_from_every_export_field():
    snapshot = {"signal":"span", "name":SECRET, "attributes":{
        "input.value":SECRET, "output.value":SECRET, "neatlogs.llm.input_messages":SECRET,
        "http.request.header.authorization":SECRET, "claim.role":SECRET,
        "claim.http_status":200, "neatlogs.llm.token_count.total":18,
        "neatlogs.span.kind":"llm", "claim.duration_ms":12.5},
        "events":[{"name":"exception", "attributes":{"exception.message":SECRET}}],
        "links":[{"attributes":{"secret":SECRET}}], "resource":{"attributes":{"host.name":SECRET}},
        "status":{"code":"ERROR", "description":SECRET}, "body":SECRET}
    result = obs.mask(snapshot)
    assert SECRET not in json.dumps(result)
    assert result["attributes"]["neatlogs.llm.token_count.total"] == 18
    assert result["status"]["code"] == "ERROR"
    assert result["events"] == [] and result["links"] == []
    assert result["name"] == "claim.operation"
    with pytest.raises(ValueError): obs.mask({"attributes":"unexpected"})


def test_telemetry_failure_does_not_rerun_or_fail_application(monkeypatch):
    def fail(*args, **kwargs): raise RuntimeError(SECRET)
    monkeypatch.setattr(obs, "_sdk", SimpleNamespace(trace=fail))
    calls = []
    with obs.span("claim.analysis", "WORKFLOW"):
        calls.append("executed once")
    assert calls == ["executed once"]
    with pytest.raises(ValueError, match="application failure"):
        with obs.span("claim.model", "LLM"):
            raise ValueError("application failure")


def test_local_logs_exclude_raw_inputs_and_exception_messages(tmp_path):
    obs.initialize("diagnostic", Settings(neatlogs_enabled=False,log_dir=tmp_path))
    try:
        @obs.traced("search", "RETRIEVER")
        def search(query): return [{"patient":query}]
        with obs.span("claim.analysis", "WORKFLOW"):
            assert search(SECRET)[0]["patient"] == SECRET
            with pytest.raises(ValueError):
                with obs.span("claim.model", "LLM"): raise ValueError(SECRET)
    finally: obs.shutdown()
    text = (tmp_path / "telemetry-diagnostic.jsonl").read_text()
    assert SECRET not in text
    assert 'ValueError' in text and 'claim.result_count' in text


def test_real_sdk_graph_and_model_export_preserve_hierarchy_usage_and_redact(monkeypatch):
    import neatlogs
    from langgraph.graph import StateGraph, START, END
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
    from neatlogs.core.masking_exporter import MaskingSpanExporter
    from app.model import LunaModel
    from app.schemas import Verification
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    neatlogs.init(api_key="synthetic",tracer_provider=provider,disable_export=True,
                  register_shutdown_handlers=False,uploads_enabled=False,mask=obs.mask)
    provider.add_span_processor(SimpleSpanProcessor(MaskingSpanExporter(exporter,obs.mask)))
    monkeypatch.setattr(obs, "_sdk", neatlogs)
    monkeypatch.setattr("app.model.settings",lambda:Settings(neatlogs_enabled=False))
    monkeypatch.setattr("app.model.ChatGPTConnection.access_token",lambda self:SECRET)
    original = httpx.Client
    def respond(request):
        content = {"decision":"supported","reasons":[],"targeted_query":None}
        events = [{"type":"response.output_text.delta","delta":json.dumps(content)},
                  {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":7,"total_tokens":18}}}]
        return httpx.Response(200,text="".join("data: "+json.dumps(e)+"\n\n" for e in events))
    monkeypatch.setattr("app.model.httpx.Client",lambda **kwargs: original(transport=httpx.MockTransport(respond),**kwargs))
    try:
        def verify(state):
            LunaModel().generate("Verifier Agent", SECRET, {"patient":SECRET}, Verification)
            return state
        builder = StateGraph(dict)
        builder.add_node("verify", verify)
        builder.add_edge(START,"verify")
        builder.add_edge("verify",END)
        with obs.span("claim.analysis", "WORKFLOW"):
            builder.compile().invoke({"patient":SECRET},config={"callbacks":obs.graph_callbacks(),"run_name":"claim.graph"})
        assert neatlogs.flush(timeout_millis=5000)
        spans = exporter.get_finished_spans()
        assert len({s.context.trace_id for s in spans}) == 1
        assert len([s for s in spans if s.parent is None]) == 1
        llm = next(s for s in spans if s.name == "claim.model")
        assert llm.attributes.get("neatlogs.llm.token_count.total",llm.attributes.get("llm.token_count.total")) == 18
        serialized = json.dumps([{ "name":s.name,"attributes":dict(s.attributes),"events":[dict(e.attributes) for e in s.events],"resource":dict(s.resource.attributes)} for s in spans])
        assert SECRET not in serialized
        assert any(s.name == 'verify' for s in spans)
        assert llm.parent is not None
    finally:
        neatlogs.shutdown(timeout_millis=5000)
        provider.shutdown()


def test_live_schema_normalization_does_not_expose_trace_io():
    from app.observability_cli import trace_summary, tree_summary
    result = trace_summary({"total":1,"results":[{"trace_id":"abc","root_span_name":"claim.analysis","duration_ms":12,"trace_input":SECRET}]})
    assert result["total_count"] == 1 and result["traces"][0]["name"] == "claim.analysis"
    tree = tree_summary({"trace_id":"abc","spans":[{"name":"claim.model","input_value":SECRET,"output_value":SECRET}]})
    assert SECRET not in json.dumps(tree)


def test_trace_reader_retrieves_all_pages():
    from app.observability_cli import read_trace
    class MCP:
        def tool(self, name, **args):
            if args.get('offset') == 1: return {"spans":[{"span_id":"second"}],"next_offset":None}
            return {"span_count":2,"spans":[{"span_id":"first"}],"next_offset":1}
    result = read_trace(MCP(), 'trace')
    assert result['all_spans_retrieved'] and result['retrieved_span_count'] == 2


def test_synthetic_smoke_closes_database_before_windows_cleanup(tmp_path, monkeypatch):
    from app import observability_smoke as smoke
    config = Settings(neatlogs_enabled=False,data_dir=tmp_path/'data',log_dir=tmp_path/'logs')
    monkeypatch.setattr(smoke,'settings',lambda:config)
    class Workflow:
        def __init__(self,run):
            self.run=run
            self.model=SimpleNamespace(check_available=lambda:None)
        def graph(self,saver):
            def invoke(*args,**kwargs):
                with smoke.db.transaction() as connection:
                    smoke.db.execute(connection,"INSERT INTO reports VALUES ('synthetic',:run,:case,:body,:time)",run=self.run['id'],case=self.run['case_id'],body=json.dumps({'requests':[],'findings':[],'review_required':False}),time=smoke.db.now())
                return {'report_id':'synthetic'}
            return SimpleNamespace(invoke=invoke)
    monkeypatch.setattr(smoke.workflow,'ClaimWorkflow',Workflow)
    original = smoke.tempfile.TemporaryDirectory
    paths=[]
    def temporary(**kwargs):
        context=original(dir=tmp_path,**kwargs)
        paths.append(context.name)
        return context
    monkeypatch.setattr(smoke.tempfile,'TemporaryDirectory',temporary)
    smoke.main()
    from pathlib import Path
    assert all(not Path(path).exists() for path in paths)
