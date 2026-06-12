"""Clinical guideline retrieval — deterministic RAG grounding for adjudication.

A small curated corpus of clinical guidance is embedded once (same local
MiniLM model used for identity matching) and searched in-process by cosine
similarity. For each detected conflict we retrieve the most relevant
guidelines and inject them into the SINGLE adjudication prompt, so the model
decides with grounding instead of from memory alone.

Design notes for the defense:
- Retrieval is code, not an LLM step: the call count stays exactly 2.
- The corpus is honest mock content like the seed data (plausible, hand
  curated for the demo); the retrieval mechanics are real vector search.
- In-process beats a DB table here: the corpus is tiny and static, and the
  demo gains nothing from a network hop. Swapping to a pgvector table later
  is a storage change, not an architecture change.
"""

from dataclasses import dataclass
from functools import lru_cache

import numpy as np

from app.embeddings import _get_model
from app.models import Conflict


@dataclass(frozen=True)
class Guideline:
    guideline_id: str
    title: str
    body: str
    source: str


# Curated demo corpus. Content is plausible-but-mock, like the seed records.
CORPUS: list[Guideline] = [
    Guideline(
        "SLNF-ANTI-014",
        "Anticoagulant and antiplatelet co-prescription",
        "Concurrent use of warfarin with aspirin or other antiplatelet agents "
        "substantially increases major bleeding risk. Co-prescription requires a "
        "documented indication and prescriber confirmation; otherwise alert the "
        "prescriber and do not consolidate the regimen silently.",
        "Sri Lanka National Formulary, 2024 edition",
    ),
    Guideline(
        "SLNF-ANTI-021",
        "Dual antiplatelet therapy after percutaneous coronary intervention",
        "Aspirin plus clopidogrel is intentional standard therapy for up to 12 "
        "months after PCI with a drug-eluting stent. When records show recent PCI, "
        "concurrent aspirin and clopidogrel is usually deliberate; verify the stent "
        "date with the prescriber rather than treating it as an error.",
        "Sri Lanka Heart Association guidance, 2025",
    ),
    Guideline(
        "SLNF-ANTI-029",
        "Clopidogrel with proton pump inhibitors",
        "Omeprazole and esomeprazole inhibit CYP2C19 and can reduce the antiplatelet "
        "effect of clopidogrel. Prefer pantoprazole when gastric protection is needed; "
        "flag existing omeprazole-clopidogrel combinations to the prescriber.",
        "Sri Lanka National Formulary, 2024 edition",
    ),
    Guideline(
        "SLCG-ALLG-003",
        "Penicillin allergy and beta-lactam prescribing",
        "A documented penicillin allergy contraindicates amoxicillin, ampicillin and "
        "other penicillin-class drugs. An allergy recorded by any reliable source "
        "must be honoured until formally delabelled; treat prescriptions against it "
        "as critical safety events requiring an immediate prescriber alert.",
        "Sri Lanka College of General Practitioners, allergy guidance 2023",
    ),
    Guideline(
        "SLCG-ALLG-011",
        "Allergy documentation across care settings",
        "Allergies recorded independently by two or more sources (for example a "
        "laboratory and a dispensing pharmacy) should be treated as corroborated and "
        "added to the consolidated record, even when the primary clinic record omits "
        "them. Omission at one site does not outweigh corroboration elsewhere.",
        "Ministry of Health interoperability circular, 2024",
    ),
    Guideline(
        "SLCG-RECON-007",
        "Resolving medication dose discrepancies between prescription and dispensing",
        "When a prescribed dose and a dispensed dose differ, the most recent "
        "prescriber record represents current intent, while the pharmacy record is "
        "authoritative for what the patient actually holds. If the newer record is "
        "the prescription, reconcile to it and notify the pharmacy; if the dispense "
        "is newer, alert the prescriber to confirm an intentional change.",
        "Ministry of Health medicines reconciliation handbook, 2024",
    ),
    Guideline(
        "SLCG-RECON-012",
        "Single-source conflicts and escalation",
        "A conflict supported by only one source on each side, with no third source "
        "to corroborate either value, should be resolved cautiously. If the records "
        "are close in date or the discrepancy is clinically significant, escalate to "
        "a clinician rather than choosing silently.",
        "Ministry of Health medicines reconciliation handbook, 2024",
    ),
    Guideline(
        "SLNF-CARD-031",
        "Amlodipine dosing",
        "Amlodipine is prescribed at 5 mg once daily, titrated to a maximum of 10 mg "
        "once daily. Both 5 mg and 10 mg are plausible maintenance doses, so a dose "
        "discrepancy between sources usually reflects a titration step; the newer "
        "record indicates current intent.",
        "Sri Lanka National Formulary, 2024 edition",
    ),
    Guideline(
        "SLNF-CARD-044",
        "Losartan dosing",
        "Losartan is initiated at 50 mg once daily and may be increased to 100 mg "
        "once daily, or reduced for hypotension or renal impairment. A recent dose "
        "reduction by the prescriber supersedes a higher previously dispensed dose.",
        "Sri Lanka National Formulary, 2024 edition",
    ),
    Guideline(
        "SLNF-GI-018",
        "NSAID use with anticoagulation",
        "Ibuprofen, naproxen and other NSAIDs raise gastrointestinal bleeding risk "
        "in anticoagulated patients. Prefer paracetamol for analgesia; if an NSAID "
        "is unavoidable, gastric protection and prescriber awareness are required.",
        "Sri Lanka National Formulary, 2024 edition",
    ),
    Guideline(
        "SLCG-ALLG-019",
        "Sulfonamide allergy cross-reactivity",
        "Documented sulfa allergy contraindicates sulfonamide antibiotics such as "
        "co-trimoxazole. Cross-reactivity with non-antibiotic sulfonamides is low "
        "but should be noted on the consolidated record.",
        "Sri Lanka College of General Practitioners, allergy guidance 2023",
    ),
    Guideline(
        "SLCG-RECON-020",
        "Provenance weighting in record reconciliation",
        "Weight each source by its role: clinics are authoritative for diagnoses and "
        "prescribing intent, pharmacies for what was dispensed, laboratories for "
        "results and allergies observed at testing. Recency strengthens a claim "
        "within a source's domain but does not transfer authority across domains.",
        "Ministry of Health medicines reconciliation handbook, 2024",
    ),
]

GUIDELINES_BY_ID: dict[str, Guideline] = {g.guideline_id: g for g in CORPUS}

# Below this cosine similarity a guideline is considered irrelevant to the conflict.
RELEVANCE_THRESHOLD = 0.30


@lru_cache(maxsize=1)
def _corpus_matrix() -> np.ndarray:
    """Embed the corpus once (unit vectors, so cosine similarity is a dot product)."""
    texts = [f"{g.title}. {g.body}" for g in CORPUS]
    return np.asarray(_get_model().encode(texts, normalize_embeddings=True))


def _conflict_query(conflict: Conflict) -> str:
    """The retrieval query: the conflict's description plus its structured detail."""
    extras = " ".join(str(v) for v in conflict.detail.values())
    return f"{conflict.description} {extras}"


def retrieve_for_conflict(conflict: Conflict, top_k: int = 2) -> list[tuple[Guideline, float]]:
    """Top guidelines for one conflict, with scores, above the relevance threshold."""
    query = np.asarray(_get_model().encode(_conflict_query(conflict), normalize_embeddings=True))
    scores = _corpus_matrix() @ query
    ranked = sorted(zip(CORPUS, scores), key=lambda pair: float(pair[1]), reverse=True)
    return [(g, float(s)) for g, s in ranked[:top_k] if float(s) >= RELEVANCE_THRESHOLD]


def retrieve_for_conflicts(conflicts: list[Conflict]) -> dict[int, list[tuple[Guideline, float]]]:
    """Retrieve per conflict, keyed by the conflict's 1-based index (the C# refs)."""
    return {i: retrieve_for_conflict(c) for i, c in enumerate(conflicts, start=1)}
