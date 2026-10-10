"""Synthetic live inference + telemetry smoke test. Uses a temporary claim database."""
import json
import sqlite3
import tempfile
from pathlib import Path
from langgraph.checkpoint.sqlite import SqliteSaver
from . import db, workflow, observability
from .config import settings
from .logging_setup import configure_logging

def main():
    config = settings()
    configure_logging("diagnostic", config)
    observability.initialize("diagnostic", config)
    original_settings, original_workflow_settings, original_engine = db.settings, workflow.settings, db._engine
    try:
        with tempfile.TemporaryDirectory(prefix="claim-observability-") as temporary:
            try:
                test_config = config.model_copy(update={"data_dir":Path(temporary)})
                db.settings = workflow.settings = lambda: test_config
                db._engine = None
                case_id, run_id = db.uid(), db.uid()
                docs = [
                    ("insurer_communication", "Claim reference: SYN-OBS-001. Please provide (1) a final signed discharge summary and (2) an explanation of the document submission deadline using the supplied policy and schedule. Discharge date: 2026-06-10."),
                    ("clinical", "Claim reference: SYN-OBS-001. FICTIONAL FINAL SIGNED DISCHARGE SUMMARY. Admitted 2026-06-07, discharged 2026-06-10 after treatment for dengue. Stable at discharge. Signed: Synthetic attending physician. This is a test document."),
                    ("policy", "FICTIONAL POLICY FOR TESTING ONLY. Clause 4: Submit the final discharge summary and itemized bills within 30 days after discharge. This is a document submission requirement; it does not establish claim approval or payment."),
                    ("schedule", "FICTIONAL POLICY SCHEDULE. Claim reference: SYN-OBS-001. Policy period 2026-01-01 through 2026-12-31. Clause 4 applies to inpatient hospitalization documentation. No endorsements supplied."),
                ]
                document_ids = []
                with db.transaction() as connection:
                    db.execute(connection,"INSERT INTO cases VALUES (:id,'local','Synthetic observability check','SYN-OBS-001',:time)",id=case_id,time=db.now())
                    for kind, text in docs:
                        document_id = db.uid()
                        document_ids.append(document_id)
                        db.execute(connection,"INSERT INTO documents VALUES (:id,:case,:id,1,:kind,'synthetic.txt','synthetic','unused',:pages,'extracted',:time)",
                            id=document_id,case=case_id,kind=kind,pages=json.dumps([{"page":1,"text":text,"method":"native","readable":True}]),time=db.now())
                    db.execute(connection,"INSERT INTO analyses VALUES (:id,:case,'local',:thread,'queued',:inputs,NULL,NULL,:time)",
                        id=run_id,case=case_id,thread=db.uid(),inputs=json.dumps(document_ids),time=db.now())
                run = db.rows("SELECT * FROM analyses WHERE id=:id",id=run_id)[0]
                with observability.span("claim.diagnostic", "WORKFLOW", **{"claim.synthetic":True,"claim.run_id":run_id,"claim.instrumentation_version":"1"}) as active:
                    engine = workflow.ClaimWorkflow(run)
                    engine.model.check_available()
                    with sqlite3.connect(":memory:",check_same_thread=False) as connection:
                        result = engine.graph(SqliteSaver(connection)).invoke({"run_id":run_id},config={
                            "configurable":{"thread_id":run["thread_id"]}, "recursion_limit":120,
                            "callbacks":observability.graph_callbacks(),"run_name":"claim.graph"})
                    report = json.loads(db.rows("SELECT body FROM reports WHERE id=:id",id=result["report_id"])[0]["body"])
                    print(json.dumps({"synthetic":True,"trace_id":active.trace_id,"run_id":run_id,
                        "request_count":len(report["requests"]),"finding_count":len(report["findings"]),
                        "review_required":report["review_required"],"claim_database":"temporary; user data unchanged"}))
            finally:
                if db._engine is not None and db._engine is not original_engine: db._engine.dispose()
    finally:
        db.settings, workflow.settings, db._engine = original_settings, original_workflow_settings, original_engine
        observability.shutdown()

if __name__ == "__main__":
    main()
