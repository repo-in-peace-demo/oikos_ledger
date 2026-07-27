import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation

from ..categorizer import categorize_transaction
from ..normalizer import detect_subcategory
from .base import BaseCSVParser, NarrationResult, ParsedRow, SkippedRow


class AxisParser(BaseCSVParser):
    """Parser for Axis Bank CSV statements.

    Expected columns: SRL NO, Tran Date, CHQNO, PARTICULARS, DR, CR, BAL, SOL
    Date format: DD-MM-YYYY
    Amount format: may include commas (1,040.00)
    Reference: '-' when absent
    SOL: branch code — ignored
    """

    AXIS_NARRATION_CODES: dict[str, tuple[str, str]] = {
        "ICONN": ("NEFT", "Transfer"),
        "VMT-ICON": ("Transfer", "Transfer"),
        "VMT": ("Transfer", "Transfer"),
        "AUTOSWEEP": ("Transfer", "Investment"),
        "REV SWEEP": ("Transfer", "Interest"),
        "SWEEP TRF": ("Transfer", "Transfer"),
        "CWDR": ("ATM", "ATM Withdrawal"),
        "TIP/SCG": ("Other", "Charges"),
        "RATE.DIFF": ("Other", "Charges"),
        "CLG": ("Cheque", "Transfer"),
        "EDC": ("POS", "Shopping"),
        "SETU": ("IMPS", "Transfer"),
        "INT.PD": ("Other", "Interest"),
    }

    # Prefixes whose category is a guess, not a certainty, unlike ATM-CASH-AXIS (always an ATM
    # withdrawal) or UPI/P2A (explicitly person-to-person by construction — see SLASH_PATTERNS
    # below). INB used to be treated as certain-Transfer too, on the theory that "internet
    # banking" describes a payment *method*, not a category — but real statement evidence
    # (INB/916677275/SWIGGY(RAZORPAY)/, appearing three separate times) shows INB routes plenty
    # of genuine merchant payments, exactly the same blind spot POS/PUR had before this fix. The
    # merchant behind an INB/POS/PUR/ECOM PUR/UPI-P2M transaction could be a grocer, a pharmacy, a
    # streaming service, anything. normalize_narration below routes these through the same
    # deterministic keyword scorer + subcategory detection HDFC's parser uses
    # (categorize_transaction/detect_subcategory) instead of trusting SLASH_PATTERNS' category
    # outright, and only falls back to it if that lookup genuinely finds nothing (e.g. INB
    # narrations that are genuinely gateway-only with no real merchant name, like a bare
    # "INB/.../PAYU.IN/").
    CATEGORY_UNCERTAIN_PREFIXES = frozenset({"POS", "PUR", "ECOM PUR", "INB", "UPI/P2M"})

    # Slash-pattern narrations — extracted deterministically
    # Format: {PREFIX}/{SEGMENT1}/{MERCHANT_OR_INFO}/...
    # merchant_segment_index: position of merchant in slash parts (-1 = last non-empty)
    # category here is a default — for CATEGORY_UNCERTAIN_PREFIXES it's only used as a fallback,
    # not returned outright; see normalize_narration.
    #
    # UPI/P2A vs UPI/P2M: Axis's own narration explicitly encodes which of the two this is — P2A
    # (person-to-account) names appear as personal names ("Mr Darshan Sharad Mah", "Indal
    # Chaupal"), never a merchant, so this is treated as certain Transfer, the same confidence
    # level as ATM-CASH-AXIS — no categorizer involved. P2M (person-to-merchant) names a real
    # merchant ("MAHARASHTRA PROVISION", "IRCTC UTS"), so it's in CATEGORY_UNCERTAIN_PREFIXES
    # above, same treatment as POS/PUR. ECOM PUR (e.g. "ECOM PUR/Youtube/122002/160722/18:48") is
    # a distinct prefix from plain PUR, not a variant of it — "ECOM PUR/...".startswith("PUR/") is
    # False, so without its own entry these fall through both matching steps entirely, unmatched.
    SLASH_PATTERNS: dict[str, tuple[str, str, int]] = {
        "ATM-CASH-AXIS": ("ATM", "ATM Withdrawal", -1),
        "INB": ("NEFT", "Transfer", 2),
        "POS": ("POS", "Shopping", 1),
        "PUR": ("POS", "Shopping", 1),
        "ECOM PUR": ("POS", "Shopping", 1),
        "UPI/P2A": ("UPI", "Transfer", 3),
        "UPI/P2M": ("UPI", "Transfer", 3),
    }

    @property
    def bank_name(self) -> str:
        return "Axis Bank"

    @property
    def bank_code(self) -> str:
        return "Axis"

    @property
    def column_map(self) -> dict[str, list[str]]:
        return {
            "date": ["tran date", "transaction date", "date"],
            # "particulars" only — avoids matching HDFC's "Narration" header
            "narration": ["particulars"],
            "debit": ["dr", "debit", "withdrawal", "debit amount"],
            "credit": ["cr", "credit", "deposit", "credit amount"],
            "balance": ["bal", "balance", "closing balance"],
            "reference": ["chqno", "chq no", "reference", "ref no"],
        }

    def parse_date(self, date_str: str) -> date | None:
        """Parse Axis date format DD-MM-YYYY."""
        date_str = date_str.strip()
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d-%m-%y", "%d/%m/%y"):
            try:
                return datetime.strptime(date_str, fmt).date()
            except ValueError:
                continue
        return None

    def clean_amount(self, raw: str) -> Decimal:
        """Clean Axis amount format — strip commas and spaces."""
        cleaned = raw.strip().replace(",", "").replace(" ", "")
        if not cleaned:
            return Decimal("0")
        try:
            return Decimal(cleaned)
        except InvalidOperation:
            return Decimal("0")

    def _extract_slash_merchant(self, narration: str, segment_index: int) -> str | None:
        """Extract merchant from slash-separated narration."""
        parts = narration.split("/")
        if segment_index == -1:
            non_empty = [p.strip() for p in parts if p.strip()]
            return non_empty[-1].title() if non_empty else None
        if len(parts) > segment_index:
            merchant = parts[segment_index].strip()
            # Remove trailing transaction metadata in parentheses
            merchant = re.sub(r'\(.*?\)', '', merchant).strip()
            return merchant.title() if merchant else None
        return None

    def normalize_narration(self, narration: str) -> NarrationResult | None:
        """Handle Axis Bank narration patterns.

        Priority:
        1. Slash patterns (ATM-CASH-AXIS/, INB/, POS/, PUR/, ECOM PUR/, UPI/P2A/, UPI/P2M/)
        2. Axis narration codes (CWDR, CLG, SETU, etc.)
        """
        upper = narration.upper().strip()

        # Step 1: slash pattern detection — longest prefix first
        for prefix, (payment_method, default_category, merchant_idx) in sorted(
            self.SLASH_PATTERNS.items(),
            key=lambda x: len(x[0]),
            reverse=True,
        ):
            if upper.startswith(prefix.upper() + "/"):
                merchant = self._extract_slash_merchant(narration, merchant_idx)

                if merchant is None:
                    # No merchant to categorize against either way — always defer to the
                    # registry/LLM path regardless of prefix.
                    return NarrationResult(
                        merchant=prefix.title(),
                        payment_method=payment_method,
                        category=default_category,
                        subcategory=None,
                        needs_llm=True,
                    )

                if prefix not in self.CATEGORY_UNCERTAIN_PREFIXES:
                    # ATM-CASH-AXIS, UPI/P2A — the category really is certain from the prefix
                    # alone (a cash withdrawal, or a narration Axis itself has already tagged as
                    # person-to-person).
                    return NarrationResult(
                        merchant=merchant,
                        payment_method=payment_method,
                        category=default_category,
                        subcategory=None,
                        needs_llm=False,
                    )

                # POS/PUR/ECOM PUR/INB/UPI-P2M — the category depends entirely on which merchant
                # is behind the transaction, so the prefix's own default is a fallback, not a
                # first guess. Run the same deterministic keyword scorer + subcategory detection
                # HDFC's parser relies on (both pure functions — no registry/DB/LLM access from
                # here, this stays sync).
                scored_category = categorize_transaction(narration, merchant, payment_method)
                subcategory, subcategory_override = detect_subcategory(merchant, narration)
                genuine_category = subcategory_override or (
                    scored_category if scored_category != "Other" else None
                )

                return NarrationResult(
                    merchant=merchant,
                    payment_method=payment_method,
                    category=genuine_category or default_category,
                    subcategory=subcategory,
                    # A genuine match found deterministically needs no further refinement. No
                    # match (category falls back to the static default here) means this is
                    # exactly as uncertain as a cleanly-extracted HDFC merchant with no keyword
                    # hit — eligible for the merchant-registry/LLM path in normalize_with_llm,
                    # not silently accepted as "Shopping".
                    needs_llm=genuine_category is None,
                )

        # Step 2: axis narration code detection — longest first
        for code, (payment_method, category) in sorted(
            self.AXIS_NARRATION_CODES.items(),
            key=lambda x: len(x[0]),
            reverse=True,
        ):
            if upper.startswith(code.upper()):
                remainder = narration[len(code):].strip().lstrip("-/").strip()
                merchant = remainder[:50].title() if remainder else code.title()
                return NarrationResult(
                    merchant=merchant,
                    payment_method=payment_method,
                    category=category,
                    subcategory=None,
                    needs_llm=False,
                )

        return None

    def _parse_row(
        self,
        row: dict[str, str],
        header_map: dict[str, str],
        row_number: int,
    ) -> tuple[ParsedRow, None] | tuple[None, SkippedRow]:
        """Parse single Axis CSV row."""
        raw_date = row.get(header_map.get("date", ""), "").strip()
        raw_narration = row.get(header_map.get("narration", ""), "").strip()
        debit_raw = row.get(header_map.get("debit", ""), "").strip()
        credit_raw = row.get(header_map.get("credit", ""), "").strip()
        ref_raw = row.get(header_map.get("reference", ""), "").strip()
        balance_raw = row.get(header_map.get("balance", ""), "").strip()

        def skipped(reason: str) -> tuple[None, SkippedRow]:
            return None, SkippedRow(
                row_number=row_number,
                date=raw_date,
                narration=raw_narration[:100],
                debit=debit_raw,
                credit=credit_raw,
                reference=ref_raw,
                reason=reason,  # type: ignore[arg-type]
            )

        debit = self.clean_amount(debit_raw)
        credit = self.clean_amount(credit_raw)

        if debit == Decimal("0") and credit == Decimal("0"):
            return skipped("zero_amount")

        parsed_date = self.parse_date(raw_date)
        if parsed_date is None:
            return skipped("invalid_date")

        if not raw_narration:
            return skipped("missing_narration")

        if debit > Decimal("0"):
            amount = debit
            transaction_type = "debit"
        else:
            amount = credit
            transaction_type = "credit"

        # Treat '-' and all-zero references as null
        reference_number = None
        if ref_raw and ref_raw != "-" and not re.fullmatch(r'0+', ref_raw):
            reference_number = ref_raw

        closing_balance = (
            self.clean_amount(balance_raw) if balance_raw else None
        )

        return ParsedRow(
            transaction_date=parsed_date,
            raw_description=raw_narration,
            amount=amount,
            transaction_type=transaction_type,
            reference_number=reference_number,
            closing_balance=closing_balance,
        ), None
