"""Workspace role and query-clearance policy shared by the API and retrieval."""

import re

ROLES = {'viewer': 0, 'member': 1, 'editor': 1.5, 'admin': 2, 'owner': 3}


# These deterministic rules are a user-facing guardrail. Chroma metadata filters
# below remain the security boundary: a prompt can never expand document access.
QUERY_CLEARANCE_RULES = (
    {
        'category': 'payroll and compensation',
        'minimum_role': 'admin',
        'patterns': (
            r'\bpay\s*checks?\b', r'\bpay\s*cheques?\b', r'\bpayslips?\b',
            r'\bpayroll\b', r'\bsalar(?:y|ies)\b', r'\bcompensation\b',
            r'\bwages?\b', r'\bbonuses?\b', r'\bstock\s+options?\b',
        ),
    },
    {
        'category': 'private employee records',
        'minimum_role': 'admin',
        'patterns': (
            r'\bperformance\s+reviews?\b', r'\bdisciplinary\s+(?:record|action)s?\b',
            r'\btermination\s+(?:reason|record)s?\b', r'\bmedical\s+records?\b',
            r'\bsocial\s+security\b', r'\bssn\b', r'\bhome\s+addresses?\b',
            r'\bbank\s+accounts?\b', r'\btax\s+(?:forms?|records?)\b',
        ),
    },
    {
        'category': 'credentials and secrets',
        'minimum_role': 'owner',
        'patterns': (
            r'\bpasswords?\b', r'\bapi\s+keys?\b', r'\bsecret\s+keys?\b',
            r'\baccess\s+tokens?\b', r'\bprivate\s+keys?\b', r'\bcredentials?\b',
        ),
    },
)


def retrieval_filter(scope, source_names=None):
    """Restrict retrieval by workspace, clearance, and optional explicit files."""
    workspace, separator, level = str(scope or '').partition('|')
    try:
        parsed_level = float(level)
    except (TypeError, ValueError):
        parsed_level = None
    if not workspace or not separator or parsed_level not in ROLES.values():
        raise ValueError('An authenticated workspace retrieval scope is required')
    normalized_level = int(parsed_level) if parsed_level.is_integer() else parsed_level
    filters = [{'team_id': workspace}, {'access_level': {'$lte': normalized_level}}]
    selected = list(dict.fromkeys(
        str(source_name).strip().casefold()
        for source_name in (source_names or [])
        if str(source_name).strip()
    ))
    if selected:
        filters.append({'source_name': {'$in': selected}})
    return {'$and': filters}


def query_clearance(question, role):
    """Fail closed or return the minimum role required for a sensitive query."""
    if role not in ROLES:
        return {
            'allowed': False,
            'category': 'unknown clearance',
            'minimum_role': 'owner',
            'message': 'Your access level could not be verified. Sign in again before asking the assistant.',
        }

    normalized = ' '.join(str(question or '').casefold().split())
    for rule in QUERY_CLEARANCE_RULES:
        if any(re.search(pattern, normalized, flags=re.IGNORECASE) for pattern in rule['patterns']):
            required = rule['minimum_role']
            if ROLES[role] < ROLES[required]:
                return {
                    'allowed': False,
                    'category': rule['category'],
                    'minimum_role': required,
                    'message': (
                        f"This question concerns {rule['category']}, which requires "
                        f"{required} access. Your {role} role cannot request this information. "
                        "Ask a workspace owner to review your access if this is required for your work."
                    ),
                }

    return {'allowed': True, 'category': None, 'minimum_role': role, 'message': ''}
