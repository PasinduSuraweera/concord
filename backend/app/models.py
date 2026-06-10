"""Domain models for a single clinical record pulled from one source.

These are the contracts the rest of the agent is built on: the seed datasets
produce them, the identity matcher embeds them, and the conflict detector reads
them. Per-source subclasses (clinic / lab / pharmacy) share one base so identity
and provenance are defined once.

Design note for the defense: we do NOT store any trust/reliability score on a
record. Trust is *derived* at adjudication time from the source type, the
record_date (recency), and corroboration across records. Baking a trust score
into the seed data would pre-decide the answer the agent is supposed to reason to.
"""

from datetime import date
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class SourceType(str, Enum):
    """The three kinds of source we reconcile across."""

    CLINIC = "clinic"
    LAB = "lab"
    PHARMACY = "pharmacy"


class PatientIdentity(BaseModel):
    """The demographic fields we fuzzy-match on, since sources share no patient ID.

    Every field except the name is optional because real records are incomplete:
    a missing or differently-formatted NIC is exactly the kind of noise the vector
    matcher has to see through.
    """

    full_name: str
    date_of_birth: date | None = None
    nic: str | None = None  # Sri Lankan National Identity Card number
    phone: str | None = None
    gender: str | None = None


class Medication(BaseModel):
    """A single medication. Structured (not free text) so conflict detection can
    compare drugs by name and reason about doses and interactions."""

    name: str
    dose: str | None = None
    frequency: str | None = None


class BaseRecord(BaseModel):
    """Fields shared by every source record: a provenance handle, the source it
    came from, when it was created (recency), and the patient identity block."""

    record_id: str
    source_type: SourceType
    source_name: str  # e.g. "Nawaloka Clinic, Colombo"
    record_date: date  # recency signal used during adjudication
    identity: PatientIdentity


class ClinicRecord(BaseRecord):
    """A clinic visit: the richest source — diagnoses, prescribed meds, allergies."""

    source_type: SourceType = SourceType.CLINIC
    diagnoses: list[str] = Field(default_factory=list)
    medications: list[Medication] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)


class PharmacyRecord(BaseRecord):
    """A pharmacy record: what was actually dispensed, plus any allergy alerts."""

    source_type: SourceType = SourceType.PHARMACY
    medications: list[Medication] = Field(default_factory=list)
    allergies: list[str] = Field(default_factory=list)


class LabRecord(BaseRecord):
    """A lab record: carries allergies noted at testing (e.g. contrast/reagent)
    and otherwise corroborates the patient's identity across sources."""

    source_type: SourceType = SourceType.LAB
    allergies: list[str] = Field(default_factory=list)


# Convenience union for functions that accept a record of any source type.
AnyRecord = ClinicRecord | PharmacyRecord | LabRecord


class ConflictType(str, Enum):
    """The kinds of clinical contradiction the deterministic detector flags."""

    DOSE_CLASH = "dose_clash"
    ALLERGY_MISMATCH = "allergy_mismatch"
    DRUG_INTERACTION = "drug_interaction"


class ConflictParty(BaseModel):
    """One record's contribution to a conflict, with its provenance and recency.

    Carrying source_type + record_date here is what later lets the LLM adjudicate
    on provenance and recency without re-fetching anything.
    """

    record_id: str
    source_type: SourceType
    source_name: str
    record_date: date
    value: str  # the relevant value as text, e.g. "Amlodipine 10mg" or "Penicillin allergy"


class Conflict(BaseModel):
    """A detected contradiction — FACTS ONLY.

    The detector never assigns severity or an action; those are decided by the
    LLM in adjudication (Call 1). This keeps the deterministic layer purely about
    'what disagrees', not 'how dangerous / what to do'.
    """

    conflict_type: ConflictType
    description: str
    parties: list[ConflictParty]
    detail: dict[str, Any] = Field(default_factory=dict)  # type-specific extras


class Severity(str, Enum):
    """Clinical severity the LLM assigns to a conflict during adjudication."""

    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"
    CRITICAL = "critical"


class AdjudicationAction(str, Enum):
    """The safety action the LLM recommends; executed in loop step 4."""

    PRESCRIBER_ALERT = "prescriber_alert"
    RECONCILE_RECORD = "reconcile_record"
    GENERATE_REFERRAL = "generate_referral"
    NO_ACTION = "no_action"


class ConflictAdjudication(BaseModel):
    """The LLM's verdict on a single conflict (the output of Call 1, per conflict)."""

    conflict_ref: str  # echoes the "C1"/"C2"... ref the conflict was given in the prompt
    trusted_value: str  # the value the agent decided to trust
    reasoning: str  # why, citing provenance / recency / corroboration
    severity: Severity
    action: AdjudicationAction


class Adjudication(BaseModel):
    """The full structured result of the single batched adjudication call."""

    decisions: list[ConflictAdjudication]
