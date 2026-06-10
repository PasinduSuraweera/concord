"""Loads the seeded source datasets into validated Pydantic records.

Honest scope: these three JSON files stand in for real integrations with a
clinic, a lab, and a pharmacy. The agent treats them exactly as it would treat
fetched source data — it parses and validates them through the same models — so
only the *fetch* is mocked, not the downstream intelligence.
"""

import json
from pathlib import Path

from pydantic import TypeAdapter

from app.models import AnyRecord, ClinicRecord, LabRecord, PharmacyRecord

# The JSON files live next to this loader, inside the seed package.
SEED_DIR = Path(__file__).parent

# TypeAdapters validate a whole JSON array into a list of the right record type.
_clinic_adapter = TypeAdapter(list[ClinicRecord])
_lab_adapter = TypeAdapter(list[LabRecord])
_pharmacy_adapter = TypeAdapter(list[PharmacyRecord])


def load_clinic_records() -> list[ClinicRecord]:
    return _clinic_adapter.validate_json((SEED_DIR / "clinic.json").read_text("utf-8"))


def load_lab_records() -> list[LabRecord]:
    return _lab_adapter.validate_json((SEED_DIR / "lab.json").read_text("utf-8"))


def load_pharmacy_records() -> list[PharmacyRecord]:
    return _pharmacy_adapter.validate_json((SEED_DIR / "pharmacy.json").read_text("utf-8"))


def load_all_records() -> list[AnyRecord]:
    """Every record from every source, flattened — the agent's full raw pool."""
    return [*load_clinic_records(), *load_lab_records(), *load_pharmacy_records()]
