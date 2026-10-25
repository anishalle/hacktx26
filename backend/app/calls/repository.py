import json

import boto3
from botocore.config import Config

from app.core.config import Settings


class CallRepository:
    def __init__(self, settings: Settings):
        if not settings.DATABASE_CLUSTER_ARN or not settings.DATABASE_SECRET_ARN:
            raise RuntimeError("Call database is not configured")
        self.client = boto3.client(
            "rds-data",
            region_name=settings.AWS_REGION,
            config=Config(
                connect_timeout=3, read_timeout=10, retries={"max_attempts": 1}
            ),
        )
        self.database = {
            "resourceArn": settings.DATABASE_CLUSTER_ARN,
            "secretArn": settings.DATABASE_SECRET_ARN,
            "database": settings.DATABASE_NAME,
        }

    def execute(self, sql: str, **parameters) -> list[dict]:
        values = []
        for name, value in parameters.items():
            if value is None:
                field = {"isNull": True}
            elif isinstance(value, bool):
                field = {"booleanValue": value}
            elif isinstance(value, int):
                field = {"longValue": value}
            else:
                field = {"stringValue": str(value)}
            values.append({"name": name, "value": field})
        response = self.client.execute_statement(
            **self.database,
            sql=sql,
            parameters=values,
            includeResultMetadata=True,
        )
        columns = [column["name"] for column in response.get("columnMetadata", [])]
        return [
            {
                name: None if cell.get("isNull") else next(iter(cell.values()))
                for name, cell in zip(columns, record, strict=True)
            }
            for record in response.get("records", [])
        ]

    def call(self, call_id: str):
        rows = self.execute(
            "SELECT id, group_id, meeting_id, meeting_json::text AS meeting_json, "
            "started_ms, ended_at::text AS ended_at FROM video_calls WHERE id=:id",
            id=call_id,
        )
        return rows[0] if rows else None

    def member(self, call_id: str, token_hash: str):
        rows = self.execute(
            "SELECT attendee_id, user_id, is_host FROM video_call_members "
            "WHERE call_id=:id AND token_hash=:token",
            id=call_id,
            token=token_hash,
        )
        return rows[0] if rows else None

    def create(self, call_id, group_id, meeting, started_ms, attendee, user_id, token):
        self.execute(
            "WITH new_call AS (INSERT INTO video_calls "
            "(id,group_id,meeting_id,meeting_json,started_ms) "
            "VALUES (:id,:group_id,:meeting_id,CAST(:meeting AS jsonb),:started_ms) "
            "RETURNING id) INSERT INTO video_call_members "
            "(call_id,attendee_id,user_id,token_hash,is_host) "
            "SELECT id,:attendee_id,:user_id,:token,true FROM new_call",
            id=call_id,
            group_id=group_id,
            meeting_id=meeting["MeetingId"],
            meeting=json.dumps(meeting),
            started_ms=started_ms,
            attendee_id=attendee["AttendeeId"],
            user_id=user_id,
            token=token,
        )

    def add_member(self, call_id, attendee_id, user_id, token):
        self.execute(
            "INSERT INTO video_call_members "
            "(call_id,attendee_id,user_id,token_hash) "
            "VALUES (:id,:attendee,:user,:token)",
            id=call_id,
            attendee=attendee_id,
            user=user_id,
            token=token,
        )

    def store(self, call_id, result):
        alternative = result.alternatives[0]
        self.execute(
            "INSERT INTO video_call_transcripts "
            "(call_id,result_id,start_ms,end_ms,text,items,is_partial) "
            "VALUES (:id,:result,:start,:end,:text,CAST(:items AS jsonb),:partial) "
            "ON CONFLICT (call_id,result_id) DO UPDATE SET "
            "start_ms=EXCLUDED.start_ms,end_ms=EXCLUDED.end_ms,text=EXCLUDED.text,"
            "items=EXCLUDED.items,is_partial=EXCLUDED.is_partial,received_at=now() "
            "WHERE video_call_transcripts.is_partial AND "
            "(NOT EXCLUDED.is_partial OR "
            "EXCLUDED.end_ms >= video_call_transcripts.end_ms)",
            id=call_id,
            result=result.result_id,
            start=result.start_time_ms,
            end=result.end_time_ms,
            text=alternative.transcript,
            items=json.dumps(
                [item.model_dump(by_alias=True) for item in alternative.items]
            ),
            partial=result.is_partial,
        )

    def recent(self, call_id, start_ms, at_ms):
        rows = self.execute(
            "SELECT result_id,start_ms,end_ms,text,items::text AS items,is_partial "
            "FROM video_call_transcripts WHERE call_id=:id "
            "AND end_ms >= :start AND start_ms <= :at "
            "ORDER BY start_ms DESC LIMIT 200",
            id=call_id,
            start=start_ms,
            at=at_ms,
        )
        return [{**row, "items": json.loads(row["items"])} for row in reversed(rows)]

    def end(self, call_id):
        self.execute(
            "UPDATE video_calls SET ended_at=COALESCE(ended_at,now()) WHERE id=:id",
            id=call_id,
        )
