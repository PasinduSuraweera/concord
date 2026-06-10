"""A small, curated clinical rulebook for deterministic conflict detection.

This is hand-authored domain knowledge, kept intentionally tiny and offline (no
paid drug API). It covers the planted demo cases plus a handful of neighbours so
it reads as a reusable rulebook, not one-off demo wiring. All lookups are
case-insensitive.
"""

# Drug name -> broad class. Used for allergy contraindication checks.
DRUG_CLASS: dict[str, str] = {
    "amoxicillin": "penicillin",
    "ampicillin": "penicillin",
    "flucloxacillin": "penicillin",
    "penicillin": "penicillin",
    "cephalexin": "cephalosporin",
    "aspirin": "nsaid",
    "ibuprofen": "nsaid",
    "naproxen": "nsaid",
    "clopidogrel": "antiplatelet",
    "warfarin": "anticoagulant",
    "amlodipine": "calcium-channel-blocker",
    "metformin": "biguanide",
    "paracetamol": "analgesic",
    "cetirizine": "antihistamine",
}

# Allergy term -> the drug class it contraindicates.
ALLERGY_BLOCKS: dict[str, str] = {
    "penicillin": "penicillin",
    "aspirin": "nsaid",
    "nsaid": "nsaid",
    "sulfa": "sulfonamide",
}

# Unordered drug pair -> interaction risk description.
INTERACTIONS: dict[frozenset[str], str] = {
    frozenset({"warfarin", "aspirin"}): "increased bleeding risk (anticoagulant + antiplatelet)",
    frozenset({"warfarin", "ibuprofen"}): "increased GI bleeding risk",
    frozenset({"warfarin", "naproxen"}): "increased GI bleeding risk",
    frozenset({"clopidogrel", "aspirin"}): "increased bleeding risk (dual antiplatelet)",
}


def _key(name: str) -> str:
    return name.strip().lower()


def drug_class(name: str) -> str | None:
    """The broad class of a drug, or None if we don't know it."""
    return DRUG_CLASS.get(_key(name))


def allergy_contraindicates(allergy: str, drug: str) -> bool:
    """True if a recorded allergy makes prescribing this drug dangerous."""
    blocked_class = ALLERGY_BLOCKS.get(_key(allergy))
    return blocked_class is not None and drug_class(drug) == blocked_class


def interaction_risk(drug_a: str, drug_b: str) -> str | None:
    """The interaction risk between two drugs, or None if they're compatible."""
    return INTERACTIONS.get(frozenset({_key(drug_a), _key(drug_b)}))
