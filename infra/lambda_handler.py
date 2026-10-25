"""AWS adapter for the existing FastAPI app; no product behavior lives here."""

from mangum import Mangum

from app.main import app

handler = Mangum(app, lifespan="off")
