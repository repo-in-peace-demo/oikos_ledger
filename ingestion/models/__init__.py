"""Exports all SQLModel table models and enums for use by the ingestion pipeline and scripts."""

from .macro import MacroEconomicData, MacroIndicator
from .memory import EpisodicEvent, SemanticFact
from .recommendations import (
    Insight,
    QueryCache,
    Recommendation,
    RecommendationPriority,
    RecommendationType,
    VoiceMessage,
    VoiceRole,
    VoiceSession,
)
from .transactions import (
    AccountType,
    AmendedBy,
    Category,
    Merchant,
    Transaction,
    TransactionAmendment,
    TransactionType,
)
from .users import BankAccount, Upload, UploadStatus, User

__all__ = [
    # users
    "User",
    "BankAccount",
    "Upload",
    "UploadStatus",
    # transactions
    "Merchant",
    "Category",
    "Transaction",
    "TransactionAmendment",
    "AccountType",
    "TransactionType",
    "AmendedBy",
    # macro
    "MacroEconomicData",
    "MacroIndicator",
    # memory
    "EpisodicEvent",
    "SemanticFact",
    # recommendations
    "Insight",
    "Recommendation",
    "RecommendationType",
    "RecommendationPriority",
    "QueryCache",
    "VoiceSession",
    "VoiceMessage",
    "VoiceRole",
]
