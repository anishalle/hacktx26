"""Small DB-API adapter for the stack's private Aurora RDS Data API."""

import json
import re
from datetime import date, datetime
from typing import Any

from psycopg.rows import dict_row

from app.core.aws import aws_client
from app.core.config import settings


def _parameter(name: str, value: Any) -> dict:
    result = {"name": name}
    if value is None:
        result["value"] = {"isNull": True}
    elif isinstance(value, bool):
        result["value"] = {"booleanValue": value}
    elif isinstance(value, int):
        result["value"] = {"longValue": value}
    elif isinstance(value, float):
        result["value"] = {"doubleValue": value}
    elif isinstance(value, (dict, list)):
        result["value"] = {"stringValue": json.dumps(value, default=str)}
        result["typeHint"] = "JSON"
    else:
        if isinstance(value, (datetime, date)):
            value = value.isoformat()
        # Jsonb is Psycopg's wrapper around the original JSON value.
        if hasattr(value, "obj"):
            value = json.dumps(value.obj, default=str)
            result["typeHint"] = "JSON"
        result["value"] = {"stringValue": str(value)}
    return result


def _bind(sql: str, params: Any) -> tuple[str, list[dict]]:
    if not params:
        return sql, []
    if isinstance(params, dict):
        names = list(params)
        values = [params[name] for name in names]
        for index, name in enumerate(names):
            sql = re.sub(
                r"%\(" + re.escape(name) + r"\)s",
                f":p{index}",
                sql,
            )
    else:
        values = list(params)
        index = iter(range(len(values)))
        sql = re.sub(r"%s", lambda _: f":p{next(index)}", sql)
    return sql, [_parameter(f"p{index}", value) for index, value in enumerate(values)]


class DataApiCursor:
    def __init__(self, connection):
        self.connection = connection
        self.rows = []
        self.rowcount = -1

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    def close(self):
        pass

    def execute(self, sql: str, params: Any = None):
        statement, parameters = _bind(sql, params)
        response = self.connection.client.execute_statement(
            resourceArn=settings.DATABASE_CLUSTER_ARN,
            secretArn=settings.DATABASE_SECRET_ARN,
            database=settings.DATABASE_NAME,
            sql=statement,
            parameters=parameters,
            includeResultMetadata=True,
        )
        metadata = response.get("columnMetadata", [])
        self.rows = []
        for record in response.get("records", []):
            values = [
                self.connection.value(field, column)
                for field, column in zip(record, metadata)
            ]
            if self.connection.row_factory is dict_row:
                self.rows.append(
                    {column["label"]: value for column, value in zip(metadata, values)}
                )
            else:
                self.rows.append(tuple(values))
        self.rowcount = response.get("numberOfRecordsUpdated", len(self.rows))
        return self

    def executemany(self, sql: str, parameters):
        rows = list(parameters)
        self.rowcount = 0
        for start in range(0, len(rows), 100):
            batch = rows[start : start + 100]
            if not batch:
                continue
            statement, _ = _bind(sql, batch[0])
            parameter_sets = [_bind(sql, row)[1] for row in batch]
            response = self.connection.client.batch_execute_statement(
                resourceArn=settings.DATABASE_CLUSTER_ARN,
                secretArn=settings.DATABASE_SECRET_ARN,
                database=settings.DATABASE_NAME,
                sql=statement,
                parameterSets=parameter_sets,
            )
            self.rowcount += len(response.get("updateResults", []))
        return self

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None

    def fetchall(self):
        result, self.rows = self.rows, []
        return result

    def fetchmany(self, size=1):
        result, self.rows = self.rows[:size], self.rows[size:]
        return result


class DataApiConnection:
    def __init__(self, row_factory=dict_row):
        self.client = aws_client("rds-data")
        self.row_factory = row_factory

    @staticmethod
    def value(field, metadata):
        if field.get("isNull"):
            return None
        for key in (
            "stringValue",
            "longValue",
            "doubleValue",
            "booleanValue",
            "blobValue",
            "arrayValue",
        ):
            if key in field:
                value = field[key]
                if (
                    metadata.get("typeName", "").lower() in {"json", "jsonb"}
                    and key == "stringValue"
                ):
                    try:
                        return json.loads(value)
                    except ValueError:
                        return value
                return value
        return None

    def execute(self, sql, params=None):
        return self.cursor().execute(sql, params)

    def cursor(self):
        return DataApiCursor(self)

    def executemany(self, sql, params):
        return self.cursor().executemany(sql, params)

    def commit(self):
        # Each Data API call commits unless an explicit transaction ID is supplied.
        pass

    def rollback(self):
        pass

    def close(self):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.commit()
        self.close()
